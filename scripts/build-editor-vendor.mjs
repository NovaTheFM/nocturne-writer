import { build } from 'esbuild';

await build({
  entryPoints: ['src/editor/nocturne-tiptap-entry.js'],
  outfile: 'src/vendor/tiptap/nocturne-tiptap.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: true,
});

console.log('Tiptap vendor bundle written to src/vendor/tiptap/nocturne-tiptap.bundle.js');
