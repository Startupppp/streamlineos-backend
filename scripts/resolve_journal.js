const fs = require('fs');
const path = require('path');

const filePath = '/Users/tarunchintakunta/Personal/streamline/streamlineos-backend/migrations/meta/_journal.json';
const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
const resolvedLines = [];

let inConflict = false;
let keepLine = true;

for (const line of lines) {
  if (line.trim().startsWith('<<<<<<< HEAD')) {
    inConflict = true;
    keepLine = true; // Wait! The prompt says keep origin/main.
    // So while in <<<<<<< HEAD, we drop lines UNTIL =======
    keepLine = false;
    let headPart = true;
    continue;
  } else if (line.trim().startsWith('=======')) {
    // Now we enter the origin/main part, so we keep lines.
    keepLine = true;
    continue;
  } else if (line.trim().startsWith('>>>>>>> origin/main')) {
    // Conflict ends.
    inConflict = false;
    keepLine = true;
    continue;
  }

  if (inConflict) {
    if (keepLine) {
      resolvedLines.push(line);
    }
  } else {
    resolvedLines.push(line);
  }
}

fs.writeFileSync(filePath, resolvedLines.join('\n'));
console.log('Done resolving _journal.json');
