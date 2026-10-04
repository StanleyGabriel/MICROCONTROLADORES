const express = require('express');
const path = require('path');

// =====================================================================
// Banco de dados
//  - Na Vercel: Postgres (Neon) via variavel DATABASE_URL / POSTGRES_URL
//  - No seu PC (sem essas variaveis): SQLite embutido no Node (arquivo local)
// =====================================================================
// Aceita DATABASE_URL / POSTGRES_URL e tambem nomes com prefixo que a Vercel cria
// ao conectar o Neon (ex.: STORAGE_DATABASE_URL, NEON_DATABASE_URL, XYZ_POSTGRES_URL).
const acharUrlBanco = () => {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const chave = Object.keys(env).find((k) => /(^|_)DATABASE_URL$/.test(k))
             || Object.keys(env).find((k) => /(^|_)POSTGRES_URL$/.test(k));
  return chave ? env[chave] : null;
};
const DB_URL = acharUrlBanco();
let q; // q(sql, params) -> { rows, count }   (SQL sempre com $1, $2...)

// O banco so e aberto na primeira requisicao: se algo estiver errado, a API responde
// com a mensagem do erro (em vez de a funcao inteira cair na Vercel).
if (DB_URL) {
  let pool;
  q = async (sql, params = []) => {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    }
    const r = await pool.query(sql, params);
    return { rows: r.rows, count: r.rowCount };
  };
} else {
  let db;
  q = async (sql, params = []) => {
    if (!db) {
      if (process.env.VERCEL) throw new Error(
        'DATABASE_URL nao configurada. Na Vercel: Storage -> Neon -> conectar ao projeto e fazer Redeploy.');
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(__dirname, 'antifurto.db'));
    }
    const stmt = db.prepare(sql.replace(/\$\d+/g, '?'));
    if (/^\s*(SELECT|WITH)|RETURNING/i.test(sql)) return { rows: stmt.all(...params).map(r => ({ ...r })), count: 0 };
    const r = stmt.run(...params);
    return { rows: [], count: r.changes };
  };
}

const AGORA = DB_URL ? 'NOW()' : "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tags (
     uid       TEXT PRIMARY KEY,
     nome      TEXT,
     liberada  INTEGER NOT NULL DEFAULT 1,
     criada_em ${DB_URL ? 'TIMESTAMPTZ' : 'TEXT'} DEFAULT (${AGORA})
   )`,
  `CREATE TABLE IF NOT EXISTS eventos (
     id   ${DB_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
     uid  TEXT NOT NULL,
     tipo TEXT NOT NULL,
     data ${DB_URL ? 'TIMESTAMPTZ' : 'TEXT'} DEFAULT (${AGORA})
   )`,
  `CREATE TABLE IF NOT EXISTS config (
     chave TEXT PRIMARY KEY,
     valor TEXT
   )`,
];
// Fluxo:  1) produtos (tags) sao cadastrados antes, pelo painel, como NAO PAGOS
//         2) no caixa (leitor 2, ligado pelo painel) a tag lida vira PAGA = liberada
//         3) no portal (leitor 1): paga -> passa | nao paga ou desconhecida -> alarme
// Tipos de evento: IDENTIFICADA | PRODUTO | PAGAMENTO | ESTORNO | REMOCAO | RESET | PASSAGEM_OK | ALARME
//                  | DESCONHECIDA (tag sem cadastro no portal) | CAIXA_DESCONHECIDA | LEITURA_ON | LEITURA_OFF

let pronto;
const iniciarBanco = () => (pronto ??= (async () => { for (const s of SCHEMA) await q(s); })()
  .catch((e) => { pronto = null; throw e; }));   // se falhar, tenta de novo na proxima requisicao

const norm = (uid) => String(uid || '').trim().toUpperCase();
const logEvento = (uid, tipo) => q('INSERT INTO eventos (uid, tipo) VALUES ($1, $2)', [uid, tipo]);
const getTag = async (uid) => (await q('SELECT * FROM tags WHERE uid = $1', [uid])).rows[0];
const getConfig = async (chave) => (await q('SELECT valor FROM config WHERE chave = $1', [chave])).rows[0]?.valor ?? null;
const setConfig = (chave, valor) => q(
  'INSERT INTO config (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor',
  [chave, String(valor)]);

const ONLINE_MS = 15000; // ESP32 e considerado online se falou com a API nos ultimos 15 s

const IDENTIFICAR_MS = 60000; // modo "identificar tag" desliga sozinho depois de 60 s

async function identificando() {
  const ate = Number(await getConfig('identificar_ate')) || 0;
  return ate > Date.now();
}

// Guarda a tag lida no modo identificar (o painel usa para preencher o UID)
async function registrarIdentificacao(uid) {
  await setConfig('identificar_ate', 0);            // um disparo so
  await setConfig('ultima_identificada', JSON.stringify({ uid, em: Date.now() }));
  await logEvento(uid, 'IDENTIFICADA');
  const tag = await getTag(uid);
  return { uid, identificar: true, liberada: false, cadastrada: !!tag, nome: tag ? tag.nome : null };
}

async function statusSistema() {
  const ativo = (await getConfig('cadastro_ativo')) === '1';
  const visto = await getConfig('esp32_visto');
  const online = !!visto && Date.now() - Number(visto) < ONLINE_MS;
  const ate = Number(await getConfig('identificar_ate')) || 0;
  let identificada = null;
  try { identificada = JSON.parse(await getConfig('ultima_identificada')); } catch { /* vazio */ }
  if (identificada) {
    const tag = await getTag(identificada.uid);
    identificada = { ...identificada, em: new Date(identificada.em).toISOString(), cadastrada: !!tag, nome: tag ? tag.nome : null };
  }
  return {
    cadastroAtivo: ativo, esp32Online: online, esp32VistoEm: visto ? new Date(Number(visto)).toISOString() : null,
    identificando: ate > Date.now(), identificarAte: ate > Date.now() ? new Date(ate).toISOString() : null,
    identificada,
  };
}

// =====================================================================
// App
// =====================================================================
const app = express();
app.use(express.json());

// CORS: permite abrir o painel de qualquer lugar (ex.: arquivo local, outro dominio)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', 'public')));   // painel na pasta public/ da raiz do repo

app.use('/api', async (req, _res, next) => {
  try { await iniciarBanco(); next(); } catch (e) { next(e); }
});

// Envolve rotas async para que erros virem resposta 500 em JSON
const r = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- ESP32 ----------

// Leitor 1 (portal): a tag pode sair?
app.get('/api/tags/:uid/verificar', r(async (req, res) => {
  const uid = norm(req.params.uid);
  if (await identificando()) return res.json(await registrarIdentificacao(uid));   // modo identificar: sem alarme
  const tag = await getTag(uid);
  const liberada = !!(tag && tag.liberada);
  // Tag sem cadastro nao e produto da loja: so registra, sem alarme
  await logEvento(uid, liberada ? 'PASSAGEM_OK' : (tag ? 'ALARME' : 'DESCONHECIDA'));
  res.json({ uid, liberada, cadastrada: !!tag, alarme: !!tag && !liberada, nome: tag ? tag.nome : null });
}));

// Leitor 2 (caixa): marca a tag como PAGA. So funciona para tags ja cadastradas.
app.post('/api/tags/:uid/pagar', r(async (req, res) => {
  const uid = norm(req.params.uid);
  if (await identificando()) return res.json(await registrarIdentificacao(uid));   // modo identificar: nao paga
  const tag = await getTag(uid);
  if (!tag) {
    await logEvento(uid, 'CAIXA_DESCONHECIDA');
    return res.status(404).json({ erro: 'Tag nao cadastrada', uid });
  }
  await q('UPDATE tags SET liberada = 1 WHERE uid = $1', [uid]);
  await logEvento(uid, 'PAGAMENTO');
  res.json({ ...(await getTag(uid)), jaEstavaPaga: !!tag.liberada });
}));

// O ESP32 chama a cada ~1,5 s: recebe se o leitor do caixa deve estar ligado
// e, de quebra, avisa que esta online.
app.get('/api/dispositivo/comando', r(async (_req, res) => {
  await setConfig('esp32_visto', Date.now());
  res.json({ cadastroAtivo: (await getConfig('cadastro_ativo')) === '1', identificar: await identificando() });
}));

// ---------- Painel (front) ----------

app.get('/api/status', r(async (_req, res) => res.json(await statusSistema())));

// Diagnostico: qual banco esta em uso e quantos registros ha em cada tabela
app.get('/api/saude', r(async (_req, res) => {
  const contar = async (t) => Number((await q(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  res.json({
    ok: true,
    banco: DB_URL ? 'Postgres (Neon)' : 'SQLite local',
    host: DB_URL ? (DB_URL.match(/@([^/:?]+)/) || [])[1] : null,
    tabelas: { tags: await contar('tags'), eventos: await contar('eventos'), config: await contar('config') },
  });
}));

// Liga/desliga a leitura do leitor do caixa.  Body: { "ativo": true | false }
app.post('/api/cadastro', r(async (req, res) => {
  const ativo = !!req.body.ativo;
  const antes = (await getConfig('cadastro_ativo')) === '1';
  await setConfig('cadastro_ativo', ativo ? '1' : '0');
  if (ativo !== antes) await logEvento('-', ativo ? 'LEITURA_ON' : 'LEITURA_OFF');
  res.json(await statusSistema());
}));

// Modo "identificar tag": a proxima tag lida em QUALQUER leitor so e identificada
// (sem alarme, sem pagamento) e o painel preenche o UID.  Body: { "ativo": true | false }
app.post('/api/identificar', r(async (req, res) => {
  const ativo = req.body.ativo !== false;
  await setConfig('identificar_ate', ativo ? Date.now() + IDENTIFICAR_MS : 0);
  res.json(await statusSistema());
}));

app.get('/api/tags', r(async (_req, res) => {
  res.json((await q('SELECT * FROM tags ORDER BY nome, uid')).rows);
}));

// Cadastra um produto (tag) - entra como NAO PAGO.  Body: { "uid": "038757AD", "nome": "Camiseta" }
// Se ja existir, so atualiza o nome (nao mexe no pagamento).
app.post('/api/tags', r(async (req, res) => {
  const uid = norm(req.body.uid);
  if (!/^[0-9A-F]{8,20}$/.test(uid)) return res.status(400).json({ erro: 'UID invalido' });
  const nome = req.body.nome || null;
  const existia = await getTag(uid);
  await q(`INSERT INTO tags (uid, nome, liberada) VALUES ($1, $2, 0)
           ON CONFLICT (uid) DO UPDATE SET nome = COALESCE(excluded.nome, tags.nome)`, [uid, nome]);
  if (!existia) await logEvento(uid, 'PRODUTO');
  res.status(existia ? 200 : 201).json(await getTag(uid));
}));

// Alterar nome e/ou pagamento pelo painel.  Body: { "nome"?: "...", "liberada"?: 0 | 1 }
app.patch('/api/tags/:uid', r(async (req, res) => {
  const uid = norm(req.params.uid);
  const tag = await getTag(uid);
  if (!tag) return res.status(404).json({ erro: 'Tag nao encontrada' });
  const liberada = req.body.liberada === undefined ? tag.liberada : (req.body.liberada ? 1 : 0);
  const nome = req.body.nome === undefined ? tag.nome : (req.body.nome || null);
  await q('UPDATE tags SET liberada = $1, nome = $2 WHERE uid = $3', [liberada, nome, uid]);
  if (liberada !== tag.liberada) await logEvento(uid, liberada ? 'PAGAMENTO' : 'ESTORNO');
  res.json(await getTag(uid));
}));

app.delete('/api/tags/:uid', r(async (req, res) => {
  const uid = norm(req.params.uid);
  const { count } = await q('DELETE FROM tags WHERE uid = $1', [uid]);
  if (!count) return res.status(404).json({ erro: 'Tag nao encontrada' });
  await logEvento(uid, 'REMOCAO');
  res.status(204).end();
}));

// Reinicia a demonstracao: todas as tags voltam a NAO PAGAS
app.post('/api/tags/resetar', r(async (_req, res) => {
  await q('UPDATE tags SET liberada = 0');
  await logEvento('-', 'RESET');
  res.json((await q('SELECT * FROM tags ORDER BY nome, uid')).rows);
}));

app.get('/api/eventos', r(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json((await q(`SELECT e.*, t.nome FROM eventos e LEFT JOIN tags t ON t.uid = e.uid
                     ORDER BY e.id DESC LIMIT $1`, [limit])).rows);
}));

// Erros -> JSON (aparece nos logs da Vercel)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro no servidor', detalhe: String(err.message || err) });
});

module.exports = app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API antifurto rodando na porta ${PORT} (${DB_URL ? 'Postgres' : 'SQLite local'})`);
  console.log(`Painel: http://localhost:${PORT}`);
});
