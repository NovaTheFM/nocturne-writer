import {build} from "esbuild";
import {readFile, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const root = new URL("../", import.meta.url);
const scratch = fileURLToPath(new URL("./", import.meta.url));
const result = await build({
  entryPoints: [fileURLToPath(new URL("prototype.jsx", import.meta.url))],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  nodePaths: [fileURLToPath(new URL("./node_modules/", import.meta.url))],
  alias: {
    react: scratch+"node_modules/react",
    "react-dom": scratch+"node_modules/react-dom",
  },
  define: {"process.env.NODE_ENV": '"production"'},
});
const js = new TextDecoder().decode(result.outputFiles[0].contents).replace(/<\/script/gi, "<\\/script");
const css = await readFile(new URL("prototype.css", import.meta.url), "utf8");
const fontFiles = [
  ["Manrope",400,"755fa076675e6f6181d8.ttf"],
  ["Manrope",600,"900670474e93d412231f.ttf"],
];
const fontCss = (await Promise.all(fontFiles.map(async ([family,weight,name]) => {
  const font = await readFile(new URL("src/assets/fonts/"+name, root));
  return "@font-face{font-family:'"+family+"';font-style:normal;font-weight:"+weight+";font-display:swap;src:url(data:font/ttf;base64,"+font.toString("base64")+") format('truetype')}";
}))).join("");
const html = "<!doctype html>\n<html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#111419\"><title>Nocturne Studio · React + Material UI concept</title><style>"+fontCss+css+"</style></head><body><div id=\"root\"></div><script>"+js+"</script></body></html>\n";
await writeFile(new URL("nocturne-react-mui.html", import.meta.url), html);
console.log("Single-file prototype: "+Buffer.byteLength(html)+" bytes");
