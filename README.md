# Antifurto RFID — API + Painel

- `server.js` — API (Express). Usa **Postgres** quando existe `DATABASE_URL`/`POSTGRES_URL` (Vercel + Neon) e **SQLite local** (`antifurto.db`) quando não existe.
- `public/index.html` — painel web (servido pela própria API em `/`).

## Rodar no PC
```
npm install
npm start          # http://localhost:3000
```

## Vercel
1. Projeto na Vercel → **Storage → Create Database → Neon (Postgres)** → conectar ao projeto. Isso cria a variável `DATABASE_URL`.
2. Se o código estiver na pasta `rfid/` do repositório: **Settings → General → Root Directory = `rfid`**.
3. Fazer push no GitHub (ou **Redeploy**). As tabelas são criadas sozinhas na primeira requisição.

## Rotas
| Quem | Método | Rota | Uso |
|---|---|---|---|
| ESP32 | GET | `/api/tags/:uid/verificar` | portal: `{ liberada }` |
| ESP32 | POST | `/api/tags` `{uid}` | cadastro: libera a tag |
| ESP32 | GET | `/api/dispositivo/comando` | `{ cadastroAtivo }` + marca o ESP32 como online |
| Painel | GET | `/api/status` | `{ cadastroAtivo, esp32Online, esp32VistoEm }` |
| Painel | POST | `/api/cadastro` `{ativo: true/false}` | inicia/para a leitura do leitor 2 |
| Painel | GET | `/api/tags` | lista |
| Painel | PATCH | `/api/tags/:uid` `{nome?, liberada?}` | renomear / bloquear |
| Painel | DELETE | `/api/tags/:uid` | remover |
| Painel | GET | `/api/eventos?limit=50` | histórico |

## Ligação do LED verde (novo)
GPIO **33** (terminal S) → resistor 220 Ω → perna longa do LED verde; perna curta → G (GND).
O botão físico foi removido (o caixa é ligado pelo painel). Requests e responses completos: ver `API.md`.
