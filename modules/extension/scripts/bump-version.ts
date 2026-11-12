import * as fs from 'fs';

const releaseNotes = fs.readFileSync('release-notes.md', 'utf8');
const match = /^#####\s+v(\d+\.\d+\.\d+)\s/m.exec(releaseNotes);

if (!match) {
    throw new Error('Cannot find version in release notes');
}
const version = match[1];

console.log('Version:', version);

replaceInJson('package.json');
replaceInJson('manifest.json');

console.log('Done');

function replaceInJson(fileName: string) {
    const data = fs.readFileSync(fileName, 'utf8');
    const parsed = JSON.parse(data);
    parsed.version = version;
    fs.writeFileSync(fileName, JSON.stringify(parsed, null, 2));
}
