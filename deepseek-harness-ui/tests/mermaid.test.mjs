import test from 'node:test';
import assert from 'node:assert/strict';
import {isMindmap,parseMindmap} from '../src/mermaid.js';

test('parses Mermaid mindmap indentation into a visible hierarchy',()=>{
  const chart='mindmap\n  root((Loom))\n    Build\n      HTML\n      Markdown\n    Manage\n';
  assert.equal(isMindmap(chart),true);
  assert.deepEqual(parseMindmap(chart),{label:'Loom',children:[{label:'Build',children:[{label:'HTML',children:[]},{label:'Markdown',children:[]}]},{label:'Manage',children:[]}]});
  assert.equal(isMindmap('flowchart LR\nA-->B'),false);
});
