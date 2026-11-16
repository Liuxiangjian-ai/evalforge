/**
 * Static checks that catch the mistakes a plugin author actually makes:
 * an unresolvable import, a missing export, a malformed manifest, a client
 * bundle that never registers its factory, and drift between the manifest's
 * `files` list and what is on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const problems = [];
const notes = [];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.type !== 'module') problems.push('package.json must declare "type": "module"');
if (!pkg.dsh?.bundle?.patch) problems.push('package.json is missing dsh.bundle.patch');
if (!pkg.dsh?.client) problems.push('package.json is missing dsh.client');
for (const key of ['.', './client', './icon', './locale/*.json']) {
  if (!pkg.exports?.[key]) problems.push(`package.json exports is missing ${key}`);
}
if (!fs.existsSync(path.join(root, pkg.icon || ''))) problems.push(`declared icon is missing: ${pkg.icon}`);
for (const locale of ['en', 'zh']) {
  const file = path.join(root, 'locale', `${locale}.json`);
  if (!fs.existsSync(file)) {
    problems.push(`missing locale/${locale}.json`);
    continue;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.meta?.title) problems.push(`locale/${locale}.json is missing meta.title`);
  if (!parsed.meta?.description) problems.push(`locale/${locale}.json is missing meta.description`);
}

const patch = fs.readFileSync(path.join(root, pkg.dsh.bundle.patch), 'utf8');
if (!patch.includes(pkg.name)) problems.push(`bundle patch does not insert ${pkg.name}`);

// Host modules must import cleanly.
const hostDir = path.join(root, 'src', 'host');
const hostFiles = fs.readdirSync(hostDir).filter((file) => file.endsWith('.js'));
for (const file of hostFiles) {
  try {
    await import(pathToFileURL(path.join(hostDir, file)).href);
  } catch (err) {
    problems.push(`src/host/${file} failed to import: ${err.message}`);
  }
}

const entry = await import(pathToFileURL(path.join(root, 'index.js')).href);
for (const name of ['name', 'apply', 'inject', 'default']) {
  if (entry[name] === undefined) problems.push(`index.js does not export ${name}`);
}
if (typeof entry.apply !== 'function') problems.push('index.js apply must be a function');
if (!Array.isArray(entry.inject)) problems.push('index.js inject must be an array');
notes.push(`host entry: ${entry.name} v${entry.version}`);

// Client bundle shape: window.__ModuleLoader__.load({ id, factory }).
const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
if (!client.includes('__ModuleLoader__.load')) problems.push('client.js does not call window.__ModuleLoader__.load');
if (!client.includes(`id: '${pkg.name}'`)) problems.push(`client.js factory id must equal ${pkg.name}`);
if (!client.includes('ctx.slots.inject')) problems.push('client.js does not register a slot');
if (/\bimport\s+.*from\s+['"]/.test(client)) problems.push('client.js must not use ESM imports; it receives React through the module table');

// Declared files must exist.
for (const pattern of pkg.files || []) {
  if (pattern.includes('*')) continue;
  if (!fs.existsSync(path.join(root, pattern))) problems.push(`package.json files entry is missing on disk: ${pattern}`);
}

const required = ['README.md', 'cordis.patch.yml', 'index.js', 'client.js', 'icon.svg'];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) problems.push(`missing required file: ${file}`);
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('check: OK');
