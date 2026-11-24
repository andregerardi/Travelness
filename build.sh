#!/usr/bin/env bash
# Compila as duas versões do front-end a partir das mesmas fontes em src/:
#
#   static/app.js      -> versão servidor (Flask serve o HTML e a API)
#   docs/index.html    -> app estático do GitHub Pages, tudo embutido num arquivo
#
# A troca entre os dois backends é feita gerando src/backend.js antes de cada build
# (o esbuild só sabe apelidar pacotes, não caminhos relativos).
set -euo pipefail
cd "$(dirname "$0")"

ESBUILD="${ESBUILD:-$(command -v esbuild || echo ./node_modules/.bin/esbuild)}"
[ -x "$ESBUILD" ] || ESBUILD=/opt/npm-tools/node_modules/.bin/esbuild
COMMON=(--bundle --format=esm --target=es2020 --jsx=automatic
        --define:process.env.NODE_ENV='"production"' --legal-comments=none)

# Sem `npm install` local, aponta para um node_modules já existente (NODE_MODULES).
if [ ! -e node_modules ] && [ -d "${NODE_MODULES:-}" ]; then
  ln -sfn "$NODE_MODULES" node_modules
fi
if [ ! -e node_modules ]; then
  echo "node_modules não encontrado. Rode 'npm install' ou defina NODE_MODULES=/caminho." >&2
  exit 1
fi
MIN=(--minify)
[ "${DEV:-0}" = "1" ] && MIN=(--sourcemap)

gen_backend() {  # $1 = server | local
  cat > src/backend.js <<EOF
/* GERADO POR build.sh — não edite. Fonte: src/backend.$1.js */
export { backend } from "./backend.$1.js";
EOF
}

echo "→ versão servidor"
gen_backend server
"$ESBUILD" src/ui.jsx "${COMMON[@]}" "${MIN[@]}" --outfile=static/app.js

echo "→ app estático (docs/)"
gen_backend local
mkdir -p docs
"$ESBUILD" src/ui.jsx "${COMMON[@]}" "${MIN[@]}" --outfile=.build-web.js

node build-docs.mjs
rm -f .build-web.js
gen_backend server   # deixa a árvore no estado padrão

printf "✓ static/app.js    %s\n" "$(du -h static/app.js | cut -f1)"
printf "✓ docs/index.html  %s\n" "$(du -h docs/index.html | cut -f1)"
