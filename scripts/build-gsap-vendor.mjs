import { build } from 'esbuild';

await build({
  entryPoints: ['src/vendor/gsap/nocturne-gsap-entry.js'],
  outfile: 'src/vendor/gsap/gsap-flip.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: true,
});

console.log('GSAP + Flip vendor bundle written to src/vendor/gsap/gsap-flip.bundle.js');
