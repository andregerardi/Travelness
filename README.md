# Travelness

Prestação de contas de viagens a partir de fotos de cupons fiscais.

Você fotografa o cupom, o app lê **valor, data, CNPJ, estabelecimento e chave de acesso**,
classifica em **alimentação / combustível / transporte / outros** e entrega dois produtos:

1. **Planilha Excel** no layout de prestação de contas (seções A/B/C, fechamento, dados
   bancários e campos de assinatura) + uma aba tabular com um cupom por linha.
2. **PDF** com capa, resumo por categoria, índice e **uma página por comprovante**.

## 👉 Usar agora

**<https://andregerardi.github.io/Travelness/>**

Abra no celular e toque em *Adicionar à tela de início*. Vira um app com ícone próprio,
funciona offline e **os cupons ficam no seu aparelho** — nada é enviado para servidor nenhum.

---

## As duas versões

O mesmo código roda de dois jeitos, a partir das mesmas fontes em `src/`:

| | **App estático** (`docs/`) | **Servidor** (Flask) |
|---|---|---|
| Onde roda | navegador do celular | sua máquina / rede local |
| Onde ficam os dados | IndexedDB, no aparelho | SQLite, em `data/` |
| OCR | Tesseract.js (3–8s por cupom) | Tesseract nativo (~1s) |
| Planilha e PDF | gerados no navegador | gerados no servidor |
| E-mail | precisa do servidor | SMTP direto |
| Instalação | nenhuma | Python + Tesseract |

Os dois são independentes. Se você usar só o app estático, nunca precisa ligar o servidor —
só perde o OCR rápido e o envio automático por e-mail (o botão de compartilhar do celular
resolve, anexando os arquivos no Gmail ou WhatsApp).

**Os dois juntos:** em *Ajustes*, informe o endereço do servidor (ex.: `http://192.168.0.12:5000`).
Quando ele estiver no ar, o app manda o OCR para lá e volta a ler no aparelho sozinho se o
servidor não responder.

---

## Publicando no GitHub Pages

Já está pronto para isso. Em **Settings → Pages → Source**, escolha **main / `/docs`**.
O app fica em `https://<usuário>.github.io/<repo>/`.

Tudo em `docs/` usa caminhos relativos justamente para funcionar nesse subdiretório.
Para republicar depois de mexer na interface:

```bash
./build.sh && git add docs static && git commit -m "atualiza app" && git push
```

---

## Rodando o servidor (opcional)

```bash
pip install -r requirements.txt
sudo apt-get install -y tesseract-ocr tesseract-ocr-por poppler-utils
python app.py          # http://localhost:5000
```

Para o app do GitHub Pages poder falar com ele, o servidor precisa aceitar aquela origem:

```bash
ALLOWED_ORIGINS=https://andregerardi.github.io python app.py
```

### E-mail

Copie `.env.example` para `.env`, preencha e exporte:

```bash
set -a; source .env; set +a; python app.py
```

No Gmail use uma **senha de app**, não a senha da conta.

---

## Estrutura

```
src/                  fontes do front-end (as duas versões saem daqui)
  ui.jsx                interface React
  backend.server.js     conversa com o Flask
  backend.local.js      IndexedDB + OCR + exportadores, tudo no navegador
  store.js              persistência IndexedDB
  ocr-parse.js          extração dos campos (porte fiel de ocr.py)
  ocr-engine.js         Tesseract.js + rota opcional pelo servidor
  xlsx.js  pdf.js       geradores no navegador
docs/                 app estático publicado (gerado por build.sh)
static/ templates/    versão servidor
app.py db.py ocr.py exporters.py mailer.py    backend Flask
build.sh build-docs.mjs                        compilação
```

`src/ocr-parse.js` é um porte linha a linha de `ocr.py`. Existe um teste de paridade: os dois
devem extrair exatamente os mesmos campos do mesmo texto — se você mexer em um, mexa no outro.

### Compilando

```bash
./build.sh            # gera static/app.js e docs/index.html
DEV=1 ./build.sh      # sem minificar, com sourcemap
```

Precisa de Node só para compilar. Os arquivos gerados estão commitados, então quem só quer
usar o app não precisa de nada.

---

## Como o OCR decide

| Campo | Como é obtido |
|---|---|
| Valor | linhas com `TOTAL`, `VALOR A PAGAR`, `VALOR TOTAL`…, por prioridade. Ignora tributos, troco, subtotal e desconto. Formas de pagamento (dinheiro, cartão, PIX) só entram se nada melhor existir |
| Data/hora | prioriza linhas com `EMISSÃO`/`DATA`; aceita `dd/mm/aaaa` e `12 de jul de 2026`; descarta datas impossíveis |
| CNPJ | validado por dígito verificador; se faltar, extraído da chave de acesso |
| Chave de acesso | 44 dígitos com modelo 55/65/59 |
| Categoria | dicionário ponderado de termos (posto, litros, Uber, taxímetro, restaurante…) com desempate |
| Descrição | refeição pela hora (café/almoço/lanche/jantar), app de transporte pelo nome, "Abastecimento" para combustível |

Cada cupom recebe uma **confiança de 0 a 1**. Abaixo de 0,75, ou faltando valor/data, ele
entra marcado como **"a conferir"** — selo laranja na lista, filtro próprio e aviso na tela de
exportação. Nada é descartado em silêncio: na dúvida, o app pede revisão.

Duplicatas são bloqueadas por três critérios: imagem idêntica (SHA-256), chave de acesso
repetida ou mesmo CNPJ + data + valor.

---

## Limites conhecidos

- **A câmera só liga em HTTPS.** No GitHub Pages isso já é verdade. Se você servir pelo Flask
  em rede local (`http://192.168…`), o botão "Fotografar" abre a galeria em vez da câmera —
  use um túnel (`cloudflared`, `ngrok`) se precisar da câmera por ali.
- **Os dados do app estático vivem no navegador.** Limpar os dados do site apaga os cupons.
  Exporte a planilha e o PDF ao fim de cada viagem; é para isso que eles existem.
- **O servidor não tem autenticação.** Para uso pessoal na rede local tudo bem; antes de expor
  na internet, ponha um proxy com login na frente.
- **iOS tem cota de armazenamento menor** e pode descartar os dados de sites pouco usados.
  Instalar na tela de início reduz bastante esse risco.

---

## API do servidor

| Método | Rota | O quê |
|---|---|---|
| `GET` | `/api/health` | diz se o OCR e o e-mail estão disponíveis |
| `POST` | `/api/ocr` | lê um cupom e devolve os campos, sem gravar (usado pelo app estático) |
| `POST` | `/api/send` | recebe arquivos prontos e envia por e-mail (usado pelo app estático) |
| `GET/PUT` | `/api/profile` | dados do usuário |
| `GET/POST` | `/api/trips` | listar / criar viagem |
| `GET/PUT/DELETE` | `/api/trips/<id>` | viagem + cupons |
| `POST` | `/api/trips/<id>/receipts` | upload (multipart) ou lançamento manual (JSON) |
| `PUT/DELETE` | `/api/receipts/<id>` | editar / excluir cupom |
| `GET` | `/api/trips/<id>/export.xlsx` · `.pdf` | os dois produtos |

As três primeiras aceitam CORS, limitado por `ALLOWED_ORIGINS`.
