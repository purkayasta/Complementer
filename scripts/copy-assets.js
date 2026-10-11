// Runs after tsc: copies the files it does not emit (the hook script and the panel's HTML and CSS) next to the compiled
// code, and removes the empty stub it emits for types.ts.
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = ['src/hook.sh', 'src/views/panel.html', 'src/views/panel.css'];

for (const asset of ASSETS) {
  const destination = path.join('out', asset);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(asset, destination);
}

// types.ts only holds types, so tsc emits an empty stub that nothing requires.
fs.rmSync(path.join('out', 'src', 'types.js'), { force: true });
