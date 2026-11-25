/* Gera src/logo.js embutindo static/logo.png em base64, para a marca aparecer
   também offline. Sem o arquivo, gera uma logo vazia e o app só não a mostra. */
import { readFileSync, writeFileSync, existsSync } from "fs";

const SRC = "static/logo.png";
const OUT = "src/logo.js";
const ALT = "FGV Projetos";

const header = "/* GERADO POR make-logo.mjs — não edite. Fonte: static/logo.png */\n";

if (!existsSync(SRC)) {
  writeFileSync(OUT, `${header}export const LOGO = "";\nexport const LOGO_ALT = ${JSON.stringify(ALT)};\n`);
  console.log(`  ${SRC} não encontrado — app segue sem logo`);
} else {
  const bytes = readFileSync(SRC);
  const kb = bytes.length / 1024;
  if (kb > 200) {
    console.warn(`  aviso: ${SRC} tem ${kb.toFixed(0)} KB; base64 cresce ~33% e vai inteiro no HTML`);
  }
  const uri = `data:image/png;base64,${bytes.toString("base64")}`;
  writeFileSync(OUT, `${header}export const LOGO = ${JSON.stringify(uri)};\nexport const LOGO_ALT = ${JSON.stringify(ALT)};\n`);
  console.log(`  logo embutida (${kb.toFixed(0)} KB)`);
}
