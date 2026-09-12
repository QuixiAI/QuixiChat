/** Cheap admission happens before Markdown parsing; oversized or deeply nested text stays readable. */
export function markdownAdmission(text:string):string|null {
  if(text.length>16_384)return 'This section is shown as source because it exceeds the formatted-text limit.';
  let lines=1,delimiters=0,brackets=0,maxBrackets=0;
  for(let index=0;index<text.length;index++){
    const char=text[index]!;
    if(char==='\n'&&++lines>256)return 'This section is shown as source because it has many lines.';
    if('[]*_`~$<>\\'.includes(char)&&++delimiters>2048)return 'This section is shown as source because its formatting is unusually complex.';
    if(char==='['){maxBrackets=Math.max(maxBrackets,++brackets);if(maxBrackets>32)return 'This section is shown as source because its links are deeply nested.';}else if(char===']')brackets=Math.max(0,brackets-1);
  }
  for(const line of text.split('\n')){
    const indentation=line.match(/^[ \t]*/)?.[0]??'';
    if(indentation.replaceAll('\t','    ').length>64)return 'This section is shown as source because its indentation is deeply nested.';
    if((line.match(/^(?:\s*>){1,}/)?.[0].match(/>/g)?.length??0)>24)return 'This section is shown as source because its quotes are deeply nested.';
  }
  return null;
}
type Node={type?:string;tagName?:string;value?:string;children?:Node[];properties?:Record<string,unknown>};
function visitBounded(root:Node,maximum:number,depthLimit:number){const pending:[Node,number][]=[[root,0]];let count=0;while(pending.length){const [node,depth]=pending.pop()!;if(++count>maximum||depth>depthLimit||pending.length>maximum)throw new Error('Formatted content exceeds its display budget.');if(node.children){if(node.children.length+pending.length>maximum)throw new Error('Formatted content exceeds its display budget.');for(const child of node.children)pending.push([child,depth+1]);}}}
/** Runs after the Markdown parser and before conversion/rendering or KaTeX. */
export function remarkContentBudget(){return (tree:Node)=>{visitBounded(tree,2048,32);const pending=[tree];let math=0;while(pending.length){const node=pending.pop()!;if(node.type==='math'||node.type==='inlineMath'){if(++math>32||(node.value?.length??0)>4096)throw new Error('Math exceeds its display budget.');let depth=0;for(const char of node.value??''){if(char==='{'&&++depth>32)throw new Error('Math is deeply nested.');if(char==='}')depth=Math.max(0,depth-1);}}pending.push(...node.children??[]);}};}
/** KaTeX output is also bounded before React receives a tree. */
export function rehypeContentBudget(){return (tree:Node)=>{visitBounded(tree,12_000,80);};}
export function safeContentUrl(value:string|undefined):string|undefined {if(!value||value.length>8192||/[\x00-\x20\x7f]/.test(value))return;try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;return url.href;}catch{return;}}
