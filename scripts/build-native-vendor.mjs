import { build } from 'esbuild';
await build({ entryPoints: ['src/platform/native-entry.js'], outfile: 'src/vendor/capacitor/native.bundle.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
console.log('Capacitor native bridge bundled for offline runtime');
