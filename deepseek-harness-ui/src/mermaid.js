export function isMindmap(chart='') {
  return /^\s*mindmap(?:\s|$)/i.test(chart);
}

function labelOf(source) {
  let label=source.trim().replace(/^root\s*/i,'').replace(/:::[\w-]+$/,'').trim();
  label=label.replace(/^[\s[(<{"'`]+/,'').replace(/[\s\])}>"'`]+$/,'').trim();
  return label||'未命名节点';
}

export function parseMindmap(chart='') {
  const lines=chart.replace(/\t/g,'  ').split(/\r?\n/).filter(line=>line.trim()&&!/^\s*mindmap\s*$/i.test(line));
  const forest=[],stack=[];
  for(const line of lines) {
    const indent=line.match(/^\s*/)[0].length,node={label:labelOf(line),children:[]};
    while(stack.length&&stack.at(-1).indent>=indent)stack.pop();
    if(stack.length)stack.at(-1).node.children.push(node);else forest.push(node);
    stack.push({indent,node});
  }
  if(forest.length===1)return forest[0];
  return {label:'思维导图',children:forest};
}
