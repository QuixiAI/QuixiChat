import { Component, isValidElement, type ReactNode, useState, useSyncExternalStore } from 'react';
import type { CapabilityState } from '@quixi/core/contracts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSanitize,{defaultSchema} from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import {markdownAdmission,remarkContentBudget,rehypeContentBudget,safeContentUrl} from './markdown-budget.ts';
import {highlightLanguage,tokenize} from './highlight.ts';
import 'katex/dist/katex.min.css';
class FormattingBoundary extends Component<{text:string;children:ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<><p>Formatting could not be displayed. The source is shown below.</p><pre className="quixi-content-source">{this.props.text}</pre></>:this.props.children;}
}
const schema={...defaultSchema,attributes:{...defaultSchema.attributes,code:[...(defaultSchema.attributes?.code??[]),['className',/^language-[a-zA-Z0-9_-]{1,48}$/,'math-inline','math-display']]}};
/** Clipboard access supplied by the content access instance; absent for callers without a host. */
export interface MarkdownClipboard {state:{subscribe(listener:()=>void):()=>void;getSnapshot():CapabilityState|null};copy(text:string):Promise<void>}
const codeText=(children:ReactNode):string|null=>{if(typeof children==='string')return children;if(Array.isArray(children)&&children.every(child=>typeof child==='string'))return children.join('');if(isValidElement<{children?:ReactNode}>(children))return codeText(children.props.children);if(Array.isArray(children)&&children.length===1)return codeText(children[0]);return null;};
function CopyCode({text,clipboard}:{text:string;clipboard:MarkdownClipboard}){
  const state=useSyncExternalStore(clipboard.state.subscribe,clipboard.state.getSnapshot,clipboard.state.getSnapshot);
  const [outcome,setOutcome]=useState<{ok:boolean;message:string}|null>(null);
  if(!state?.available)return null;
  return <span className="quixi-code-copy"><button type="button" onClick={()=>{setOutcome(null);void clipboard.copy(text).then(()=>setOutcome({ok:true,message:'Copied'}),error=>setOutcome({ok:false,message:error instanceof Error?error.message:String(error)}));}}>Copy code</button>{outcome&&(outcome.ok?<span role="status">{outcome.message}</span>:<span role="alert">{outcome.message}</span>)}</span>;
}
function Formatted({text,clipboard}:{text:string;clipboard?:MarkdownClipboard|undefined}){return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm,remarkMath,remarkContentBudget]} rehypePlugins={[[rehypeSanitize,schema],[rehypeKatex,{trust:false,maxExpand:100,maxSize:20,strict:'error',throwOnError:true}],rehypeContentBudget]} urlTransform={url=>safeContentUrl(url)??''} components={{
  a({href,children}){const url=safeContentUrl(href);return url?<a href={url} target="_blank" rel="noreferrer noopener">{children}</a>:<span>{children}</span>;},
  img({alt}){return <span className="quixi-content-remote">[Image reference: {alt||'remote image'} — not loaded]</span>;},
  code({className,children}){
    // Fenced code with a supported language is coloured from bounded, lossless
    // tokens; inline code, unknown languages and over-budget blocks stay plain.
    const language=highlightLanguage(className);
    const text=typeof children==='string'?children:Array.isArray(children)&&children.every(child=>typeof child==='string')?children.join(''):null;
    const tokens=language&&text!==null?tokenize(text,language):null;
    return <code className={className}>{tokens?tokens.map((token,index)=>token.kind==='text'?token.text:<span key={index} className={`quixi-token quixi-token-${token.kind}`}>{token.text}</span>):children}</code>;
  },
  input({checked}){return <input type="checkbox" checked={!!checked} readOnly disabled aria-label={checked?'Completed task':'Incomplete task'}/>;},
  pre({children}){
    // A fenced block keeps its exact text for copying; the control appears
    // only when the host reports the clipboard available.
    const text=codeText(children);
    return <div className="quixi-code">{clipboard&&text!==null&&<CopyCode text={text} clipboard={clipboard}/>}<pre>{children}</pre></div>;
  },
}}>{text}</ReactMarkdown>;}
export function MarkdownText({text,clipboard}:{text:string;clipboard?:MarkdownClipboard|undefined}) {
  const [source,setSource]=useState(false),[offset,setOffset]=useState(0);const admission=markdownAdmission(text);
  return <div className="quixi-markdown"><button className="quixi-content-toggle" onClick={()=>setSource(value=>!value)}>{source?'Formatted view':'View source'}</button>{admission&&<p>{admission}</p>}{source||admission?<><pre className="quixi-content-source">{text.slice(offset,offset+16_384)}</pre>{text.length>16_384&&<div><button disabled={!offset} onClick={()=>setOffset(value=>Math.max(0,value-16_384))}>Previous source section</button><button disabled={offset+16_384>=text.length} onClick={()=>setOffset(value=>value+16_384)}>Next source section</button></div>}</>:<FormattingBoundary key={text} text={text}><Formatted text={text} clipboard={clipboard}/></FormattingBoundary>}</div>;
}
