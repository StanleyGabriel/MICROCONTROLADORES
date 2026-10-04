# API — requests e responses

Base: `https://microcontroladores-eosin.vercel.app/api`  ·  Corpo sempre em JSON (`Content-Type: application/json`).
Em qualquer erro de servidor: `500 {"erro":"Erro no servidor","detalhe":"..."}`.

## Usadas pela ESP32

### GET `/tags/:uid/verificar` — portal (leitor 1)
```
GET /api/tags/038757AD/verificar
200 {"uid":"038757AD","liberada":true,"cadastrada":true,"alarme":false,"nome":"Camiseta"}   -> paga: pode sair (LED verde)
200 {"uid":"038757AD","liberada":false,"cadastrada":true,"alarme":true,"nome":"Camiseta"}   -> não paga: ALARME
200 {"uid":"DEADBEEF","liberada":false,"cadastrada":false,"alarme":false,"nome":null}       -> sem cadastro: ignorada (sem alarme)
```
Grava evento `PASSAGEM_OK`, `ALARME` ou `DESCONHECIDA`.

### POST `/tags/:uid/pagar` — caixa (leitor 2): cadastra (se nova) e marca como PAGA
```
POST /api/tags/038757AD/pagar     body: {}
200 {"uid":"038757AD","nome":null,"liberada":1,"criada_em":"...","novo":true,"jaEstavaPaga":false}        (tag nova: cadastrada e paga)
200 {"uid":"038757AD","nome":"Camiseta","liberada":1,"criada_em":"...","novo":false,"jaEstavaPaga":false} (já cadastrada: paga)
```
Grava `PRODUTO` (se nova) e `PAGAMENTO`. O portal (leitor 1) nunca cadastra nada.

### GET `/dispositivo/comando` — consultada a cada 3 s
```
200 {"cadastroAtivo":true,"identificar":false}
```
Também marca o ESP32 como online.

## Usadas pelo painel

### GET `/status`
```
200 {"cadastroAtivo":false,"esp32Online":true,"esp32VistoEm":"2026-10-04T07:30:12.000Z"}
```

### POST `/cadastro` — liga/desliga o caixa
```
body: {"ativo":true}
200 {"cadastroAtivo":true,"esp32Online":true,"esp32VistoEm":"..."}
```

### POST `/identificar` — modo "identificar tag" (botão do painel)
```
body: {"ativo":true}     -> a PRÓXIMA tag lida no leitor 2 (caixa) só é identificada (sem pagar). Expira em 60 s.
body: {"ativo":false}    -> cancela
200 {...status..., "identificando":true, "identificarAte":"...", "identificada":{"uid":"038757AD","em":"...","cadastrada":false,"nome":null}}
```
Enquanto o modo está ativo, `/tags/:uid/pagar` responde
`200 {"uid":"038757AD","identificar":true,"liberada":false,"cadastrada":false,"nome":null}` e gravam o evento `IDENTIFICADA`.
O `/status` passa a trazer `identificando`, `identificarAte` e `identificada` (última tag identificada).

### GET `/tags`
```
200 [{"uid":"038757AD","nome":"Camiseta","liberada":0,"criada_em":"..."}, ...]
```

### POST `/tags` — cadastra produto (entra como NÃO PAGO)
```
body: {"uid":"038757AD","nome":"Camiseta"}
201 {"uid":"038757AD","nome":"Camiseta","liberada":0,"criada_em":"..."}     (novo)
200 {...}                                                                   (já existia: só atualiza o nome)
400 {"erro":"UID invalido"}
```

### PATCH `/tags/:uid` — renomear / marcar paga / estornar
```
body: {"nome":"Tênis"}   ou   {"liberada":1}   ou   {"liberada":0}
200 {"uid":"038757AD","nome":"Tênis","liberada":1,"criada_em":"..."}
404 {"erro":"Tag nao encontrada"}
```

### DELETE `/tags/:uid`
```
204 (sem corpo)
404 {"erro":"Tag nao encontrada"}
```

### POST `/tags/resetar` — todas voltam a não pagas
```
200 [lista de tags]
```

### GET `/eventos?limit=50`
```
200 [{"id":12,"uid":"038757AD","tipo":"PAGAMENTO","data":"...","nome":"Camiseta"}, ...]
```
Tipos: `PRODUTO`, `PAGAMENTO`, `ESTORNO`, `REMOCAO`, `RESET`, `PASSAGEM_OK`, `ALARME`, `DESCONHECIDA`, `CAIXA_DESCONHECIDA`, `LEITURA_ON`, `LEITURA_OFF`.

### GET `/saude` — diagnóstico do banco
```
200 {"ok":true,"banco":"Postgres (Neon)","host":"ep-...neon.tech","tabelas":{"tags":8,"eventos":40,"config":2}}
```
