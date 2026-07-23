import https from 'https';
import fs from 'fs';

https.get('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const exports = [
      'Scene', 'PerspectiveCamera', 'WebGLRenderer', 'AmbientLight', 'DirectionalLight',
      'PointLight', 'IcosahedronGeometry', 'OctahedronGeometry', 'BufferGeometry',
      'BufferAttribute', 'MeshStandardMaterial', 'MeshBasicMaterial', 'PointsMaterial',
      'LineBasicMaterial', 'Mesh', 'Points', 'LineSegments', 'WireframeGeometry',
      'Color', 'AdditiveBlending'
    ];
    const exportStatements = exports.map(e => `export const ${e} = THREE.${e};`).join('\n');
    const header = `var THREE;\n${data};\nif (typeof window !== 'undefined' && window.THREE) { THREE = window.THREE; }\nexport default THREE;\n`;
    const finalCode = header + exportStatements + '\n';
    fs.mkdirSync('src/vendor/three', { recursive: true });
    fs.writeFileSync('src/vendor/three/three.module.js', finalCode, 'utf8');
    console.log('Successfully wrote src/vendor/three/three.module.js with MeshBasicMaterial!');
  });
});
