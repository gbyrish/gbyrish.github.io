const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'index.html');
let code = fs.readFileSync(file, 'utf8');

const issues = [];

// --- CRITICAL ---
// Double finally blocks
const doubleFinally = code.match(/try\s*\{[\s\S]*?\}[\s\S]*?finally\s*\{[\s\S]*?\}[\s\S]*?finally\s*\{/g);
if (doubleFinally) issues.push({ sev: 'CRITICAL', count: doubleFinally.length, desc: 'Double finally blocks detected' });

// Unclosed script tags
const unclosedScript = (code.match(/<script/g) || []).length - (code.match(/<\/script>/g) || []).length;
if (unclosedScript !== 0) issues.push({ sev: 'CRITICAL', count: unclosedScript, desc: 'Unclosed script tags' });

// --- HIGH ---
// XSS: unescaped innerHTML with user data
const xssPatterns = [
  /\.innerHTML\s*=.*\$\(/,
  /\.innerHTML\s*=.*\+.*(order|user|name|email|address|phone|city|state)/i,
  /\.innerHTML\s*=.*\+.*\$.*\}/,
];
xssPatterns.forEach(p => {
  const matches = code.match(new RegExp(p.source, 'g'));
  if (matches) issues.push({ sev: 'HIGH', count: matches.length, desc: 'Potential XSS: innerHTML with unescaped variable', pattern: p.source.substring(0,60) });
});

// eval or Function constructor
const evalCalls = (code.match(/\beval\s*\(/g) || []).length;
if (evalCalls > 0) issues.push({ sev: 'HIGH', count: evalCalls, desc: 'eval() calls found' });

const newFunc = (code.match(/new\s+Function\s*\(/g) || []).length;
if (newFunc > 0) issues.push({ sev: 'HIGH', count: newFunc, desc: 'new Function() calls found' });

// --- MEDIUM ---
// Duplicate function declarations (same name)
const funcDecls = [...code.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1]);
const duplicates = funcDecls.filter((name, i) => funcDecls.indexOf(name) !== i);
if (duplicates.length > 0) issues.push({ sev: 'MEDIUM', count: [...new Set(duplicates)].length, desc: 'Duplicate function names: ' + [...new Set(duplicates)].join(', ') });

// const re-declarations
const constDups = [...code.matchAll(/const\s+(\w+)\s*=/g)].map(m => m[1]);
const constDuplicates = constDups.filter((name, i) => constDups.indexOf(name) !== i);
if (constDuplicates.length > 0) issues.push({ sev: 'MEDIUM', count: [...new Set(constDuplicates)].length, desc: 'Duplicate const declarations: ' + [...new Set(constDuplicates)].slice(0,10).join(', ') });

// let re-declarations
const letDups = [...code.matchAll(/let\s+(\w+)\s*=/g)].map(m => m[1]);
const letDuplicates = letDups.filter((name, i) => letDups.indexOf(name) !== i);
if (letDuplicates.length > 0) issues.push({ sev: 'MEDIUM', count: [...new Set(letDuplicates)].length, desc: 'Duplicate let declarations: ' + [...new Set(letDuplicates)].slice(0,10).join(', ') });

// Broken HTML tags in template strings
const brokenTags = [...code.matchAll(/<\\?span>|<\?span>|<\/?\\+span|<\s*\/\s*span\s*>/g)];
if (brokenTags.length > 0) issues.push({ sev: 'MEDIUM', count: brokenTags.length, desc: 'Broken/malformed span tags' });

// Unmatched brackets in JS
const openBraces = (code.match(/\{/g) || []).length;
const closeBraces = (code.match(/\}/g) || []).length;
const braceDiff = Math.abs(openBraces - closeBraces);
if (braceDiff > 50) issues.push({ sev: 'MEDIUM', count: braceDiff, desc: `Large brace mismatch: { x${openBraces}, } x${closeBraces}` });

// --- LOW ---
// console.log left in
const consoleLogs = (code.match(/console\.log\(/g) || []).length;
if (consoleLogs > 0) issues.push({ sev: 'LOW', count: consoleLogs, desc: 'console.log statements in production' });

// Empty catch blocks
const emptyCatches = (code.match(/catch\s*\(\w*\)\s*\{\s*\}/g) || []).length;
if (emptyCatches > 0) issues.push({ sev: 'LOW', count: emptyCatches, desc: 'Empty catch blocks' });

// == vs ===
const looseEq = (code.match(/[^=!]==[^=]/g) || []).length;
if (looseEq > 0) issues.push({ sev: 'LOW', count: looseEq, desc: 'Loose equality (==) operators' });

// TODO comments
const todos = (code.match(/\/\/\s*TODO/gi) || []).length;
if (todos > 0) issues.push({ sev: 'LOW', count: todos, desc: 'TODO comments left in code' });

// --- Summary ---
console.log('\n=== BUGSCAN RESULTS ===\n');
const sevs = ['CRITICAL','HIGH','MEDIUM','LOW'];
sevs.forEach(s => {
  const found = issues.filter(i => i.sev === s);
  if (found.length) {
    found.forEach(i => console.log(`[${s}] ${i.count}x - ${i.desc}`));
  }
});
if (issues.length === 0) console.log('No issues found!');
console.log(`\nTotal: ${issues.length} issue types across ${issues.reduce((a,i) => a + i.count, 0)} occurrences`);
