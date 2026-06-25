// Generate helper/opcodes.js from a matched VM bundle (ghostwire/akamai/vm_bundle.json).
// Re-runnable per script rotation. Derives per-version meanings, then lifts each opcode.
const fs = require('fs');
const path = require('path');
const BUNDLE = process.argv[2] || path.join(__dirname, '..', 'ghostwire', 'akamai', 'vm_bundle.json');
const B = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
const ops = B.opcodes, syms = B.symbols;
const slotNum = {}; for (const k in syms) { const s = syms[k]; if (s && typeof s.val === 'number') slotNum[k] = s.val; }

const OPER = {};
for (const k in syms) {
    const s = syms[k]; if (!s || !s.fn) continue;
    let m = s.fn.match(/return\s+\w+\s*(<<|>>>|>>|<=|>=|===|!==|==|!=|&&|\|\||[<>+\-*/%^&|])\s*\w+\s*;/);
    if (m) OPER[k] = m[1];
    else if (/return\s+!\w+\s*;/.test(s.fn)) OPER[k] = '!u';
    else if (/return\s+-\w+\s*;/.test(s.fn)) OPER[k] = '-u';
}
const bodyOfVar = v => ops[String(slotNum[v])] || '';

const pushCnt = {}; { let m, re = /this\[(\w+)\]\.push/g, all = Object.values(ops).join(' '); while ((m = re.exec(all))) pushCnt[m[1]] = (pushCnt[m[1]] || 0) + 1; }
const STACK = Object.keys(pushCnt).sort((a, b) => pushCnt[b] - pushCnt[a])[0];

let READBYTE, READINT, READSTR, SETREG, PCIDX, POP;
for (const v in slotNum) {
    const bd = bodyOfVar(v);
    if (/return this\[\w+\]\[this\[\w+\]\[[\w.]+\]\+\+\]/.test(bd)) { READBYTE = v; const mm = bd.match(/this\[\w+\]\[([\w.]+)\]\+\+/); if (mm) PCIDX = mm[1]; }
    else if (/fromCharCode/.test(bd)) READSTR = v;
    else if (/^function\(\w+,\w+\)\{this\[\w+\]\[\w+\]=\w+;?\}$/.test(bd.replace(/\s/g, ''))) SETREG = v;
}
for (const v in slotNum) { if (v === READBYTE) continue; const bd = bodyOfVar(v); if (READBYTE && (bd.match(new RegExp('this\\[' + READBYTE + '\\]\\(\\)', 'g')) || []).length >= 3 && !/fromCharCode/.test(bd)) { READINT = v; break; } }
for (const n in ops) { const m = ops[n].match(new RegExp('this\\[' + STACK + '\\]\\.push\\(\\w+\\(this\\[(\\w+)\\]\\(\\)')); if (m) { POP = m[1]; break; } }

const S = '\\s*';
const reRB = READBYTE ? 'this\\[' + READBYTE + '\\]\\(\\)' : '\\bNOPE\\b';
const reRI = READINT ? 'this\\[' + READINT + '\\]\\(\\)' : '\\bNOPE\\b';
const reRS = READSTR ? 'this\\[' + READSTR + '\\]\\(\\)' : '\\bNOPE\\b';
const rePOP = 'this\\[' + POP + '\\]\\(\\)';
const reSTKpush = 'this\\[' + STACK + '\\]\\.push';
// readInt is sometimes invoked through another object: X[READINTslotNum]()  -> treat any [READINT-keyed]() call as readInt(4B)
const reRIany = '\\[' + slotNum[READINT] + '\\]\\(\\)';

function lift(n) {
    const b = ops[n].replace(/\s/g, '');
    const P = `this\\[${POP}\\]\\(\\)`, ST = `this\\[${STACK}\\]`;

    // binop: push(OP(pop,pop))
    let m = b.match(new RegExp(`${ST}\\.push\\((\\w+)\\(${P},${P}\\)\\)`));
    if (m && OPER[m[1]] && !/u$/.test(OPER[m[1]])) return `function(){let a=this.pop();let b=this.pop();return this.push(\`\${a} ${OPER[m[1]]} \${b}\`);}`;
    // logical && / ||
    if (new RegExp(`${ST}\\.push\\(${P}&&${P}\\)`).test(b)) return `function(){let a=this.pop();let b=this.pop();return this.push(\`\${a} && \${b}\`);}`;
    if (new RegExp(`${ST}\\.push\\(${P}\\|\\|${P}\\)`).test(b)) return `function(){let a=this.pop();let b=this.pop();return this.push(\`\${a} || \${b}\`);}`;
    // typeof
    if (new RegExp(`${ST}\\.push\\(typeof${P}\\)`).test(b)) return `function(){return this.push(\`typeof \${this.pop()}\`);}`;
    // unary not: push(NOT(pop))
    m = b.match(new RegExp(`${ST}\\.push\\((\\w+)\\(${P}\\)\\)`));
    if (m && OPER[m[1]] === '!u') return `function(){return this.push(\`!(\${this.pop()})\`);}`;
    // negate: push(MUL(NEG(const),pop))
    if (new RegExp(`${ST}\\.push\\(\\w+\\(\\w+\\(\\w+\\),${P}\\)\\)`).test(b)) return `function(){return this.push(\`-1 * \${this.pop()}\`);}`;
    // push readByte / readInt / readStr literal
    if (new RegExp(`${ST}\\.push\\(${reRB}\\)`).test(b)) return `function(){return this.push(this.readByte(), true);}`;
    if (new RegExp(`${ST}\\.push\\(${reRI}\\)`).test(b)) return `function(){return this.push(this.readInt(), true);}`;
    if (new RegExp(`${ST}\\.push\\(${reRS}\\)`).test(b)) return `function(){return this.push(this.readStr());}`;
    // push undefined-box
    if (new RegExp(`${ST}\\.push\\(this\\[\\w+\\]\\(undefined\\)\\)`).test(b)) return `function(){return this.push('undefined');}`;

    // goto: setReg(PC, readInt)  (no if)
    if (SETREG && new RegExp(`this\\[${SETREG}\\]\\(${PCIDX.replace(/[.[\]]/g, '\\$&')},${reRI}\\)`).test(b) && !b.includes('if('))
        return `function(){this.term={type:'goto',target:this.readInt()};this.exit=true;}`;
    // branch: readByte(keep); readInt(target); if(pop_peek) goto / if(!..) goto
    if (SETREG && b.includes('if(') && new RegExp(`this\\[${SETREG}\\]\\(${PCIDX.replace(/[.[\]]/g, '\\$&')}`).test(b)) {
        const neg = new RegExp(`if\\(this\\[\\w+\\]\\(!`).test(b) || /if\(\w+\(this\[\w+\]/.test(b) && /!/.test(b.split('if(')[1].slice(0, 8));
        const negated = b.includes('if(' + 'this[' + (slotNum.BY || 'x') + ']') ; // best-effort
        const condNeg = /if\([A-Za-z0-9_$]+\(this\[\w+\]\(/.test(b); // wrapped in a unary -> treat as not
        return `function(){let keep=this.readByte();let target=this.readInt();this.term={type:'branch',cond:${condNeg ? '`!(${this.pop_peek(keep)})`' : 'this.pop_peek(keep)'},t:target,f:this.ptr};this.exit=true;}`;
    }
    // eof: stack=[]; setReg(PC, bytecode.length)
    if (new RegExp(`this\\[${STACK}\\]=\\[\\]`).test(b)) return `function(){this.term={type:'eof'};this.exit=true;this.stack=0;this.ptr=this.bytecode.length;}`;

    // get-member box: readByte; key=pop; obj=pop; push(obj[key])
    if (new RegExp(`${reRB};var\\w+=${P};var\\w+=${P};.*this\\[\\w+\\]\\(`).test(b) && /get z\(\)|q1|member/i.test(ops[n]) === false) { /* skip heuristic */ }
    // set-member: this[setMember](pop, pop, readByte)
    if (new RegExp(`this\\[\\w+\\]\\(${ST}\\.pop\\(\\),${P},${reRB}\\)`).test(b))
        return `function(){let key=this.pop();let val=this.pop();this.readByte();return \`v\${this.stack}[\${key}] = \${val}\`;}`;
    // get-member box: readByte; key=pop; obj=pop; box(obj,key) -> push(obj[key])
    if (new RegExp(`var\\w+=${reRB};var\\w+=${P};var\\w+=${P};var\\w+=this\\[\\w+\\]\\(\\w+,\\w+\\)`).test(b))
        return `function(){this.readByte();let key=this.pop();let obj=this.pop();this.proxy=obj;return this.push(\`\${obj}[\${key}]\`);}`;
    // push global/resolve by name: push(this[loader](readStr))
    if (new RegExp(`${ST}\\.push\\(this\\[\\w+\\]\\(${reRS}\\)\\)`).test(b))
        return `function(){return this.push(\`g(\${this.readStr()})\`);}`;

    // call: 3 readBytes (res,self,argc); pop fn; build args via kind-switch
    if (new RegExp(`var\\w+=${reRB};var\\w+=${reRB};var\\w+=${reRB};var\\w+=${P};`).test(b))
        return `function(){let res=this.readByte();this.readByte();let argc=this.readByte();let fn=this.pop();let args=[];for(let i=0;i<argc;i++){switch(this.bytes[this.pop()]){case 1:args.push('...'+this.pop());break;default:args.push(this.pop());}}let self=this.getSelf();let argList=args.reverse().join(', ');let call=(self==null||self==fn)?\`\${fn}(\${argList})\`:\`\${fn}.apply(\${self}, [\${argList}])\`;if(res)return this.push(call);return call;}`;

    // build object: readByte(count); loop pop key/val
    if (new RegExp(`var\\w+=\\{\\};var\\w+=${reRB};while`).test(b))
        return `function(){let count=this.readByte();let parts=[];while(count--){let v=this.pop();let k=this.pop();parts.unshift(\`\${k}: \${v}\`);}return this.push(\`{\${parts.join(', ')}}\`);}`;
    // build array: pop count; take from stack (no operand bytes)
    if (new RegExp(`var\\w+=\\[\\];var\\w+=${ST}\\.pop\\(\\);`).test(b))
        return `function(){let count=this.bytes[this.pop()]|0;let elems=[];for(let i=0;i<count;i++)elems.push(this.pop());return this.push(\`[\${elems.join(', ')}]\`);}`;

    // function literal: 2 readBytes + readInt(entry); push function(body@entry)
    if (new RegExp(`var\\w+=${reRB};var\\w+=${reRB};var\\w+=${reRI};`).test(b) && new RegExp(`${ST}\\.push\\(function`).test(b))
        return `function(){this.readByte();let argc=this.readByte();let entry=this.readInt();let saved=snapshot(this,['ptr','stack','argCount','proxy','fn','exit','term','bytes','kinds','last','labels','jumped']);Object.assign(this,{stack:0,bytes:{},kinds:{},last:null,fn:true,term:null,exit:false,labels:{},jumped:[]});this.argCount=argc+1;for(let i=0;i<argc;i++)this.push(null);let params=Array.from({length:argc},(_,i)=>'v'+(argc-1-i));let body=structure(graph()(this,entry));Object.assign(this,saved);return this.push('function('+params.join(', ')+') {\\n'+indent(body)+'\\n}');}`;

    // try/catch/finally: readByte; pop 3 ptrs
    if (new RegExp(`${reRB};var\\w+=${ST}\\.pop\\(\\);var\\w+=${ST}\\.pop\\(\\);var\\w+=${ST}\\.pop\\(\\);`).test(b) && b.includes('try{'))
        return `function(){this.readByte();let t=this.bytes[this.pop()];let c=this.bytes[this.pop()];let f=this.bytes[this.pop()];let lift=(e,pre)=>{let s=snapshot(this,['ptr','stack','term','exit','bytes','kinds','last','labels','jumped','fn']);Object.assign(this,{bytes:{},kinds:{},last:null,term:null,exit:false,labels:{},jumped:[]});if(pre)this.push(pre);let bd=e!=null?structure(graph()(this,e)):'';Object.assign(this,s);return bd;};return 'try {\\n'+indent(lift(t))+'\\n} catch (err) {\\n'+indent(lift(c,'err'))+'\\n} finally {\\n'+indent(lift(f))+'\\n}';}`;

    // block-exec (inline sub-dispatch until terminator): make it a no-op so the body lifts inline
    if (/while\(\w+\(\w+,[\w.]+\)\)\{this\[\w+\]\(this\)/.test(b)) return `function(){/* block-exec: body lifts inline */}`;

    // fallback: emit exact operand reads (sync) + placeholder push if it pushes
    const out = []; const re = new RegExp(`(${reRB}|${reRI}|${reRS})`, 'g'); let mm;
    while ((mm = re.exec(b))) { out.push(mm[0].includes(slotNum[READINT] + '') || mm[0] === `this[${READINT}]()` ? 'this.readInt();' : (mm[0] === `this[${READSTR}]()` ? 'this.readStr();' : 'this.readByte();')); }
    let fn = 'function(){' + out.join('') ;
    if (new RegExp(`${ST}\\.push`).test(b)) fn += `return this.push('/*op ${n}*/');`;
    return fn + '}';
}

const lines = [
    '// AUTO-GENERATED from vm_bundle.json by opcodes_from_dump.js — do not edit by hand.',
    `// STACK=${STACK} POP=${POP} readByte=${READBYTE} readInt=${READINT} readStr=${READSTR} setReg=${SETREG} PCidx=${PCIDX}`,
    "const { structure, indent } = require('./structure.js');",
    "let graph = () => require('./cfg.js').graph;",
    'function snapshot(vm, fields){let s={};for(let f of fields)s[f]=vm[f];return s;}',
    'const opcodes = {',
];
for (const n of Object.keys(ops).sort((a, b) => a - b)) lines.push(`    ${n}: ${lift(n)},`);
lines.push('};', 'module.exports = opcodes;', '');
fs.writeFileSync(path.join(__dirname, 'helper', 'opcodes.js'), lines.join('\n'));
console.log('derived STACK=%s POP=%s RB=%s RI=%s RS=%s SETREG=%s PC=%s', STACK, POP, READBYTE, READINT, READSTR, SETREG, PCIDX);
console.log('wrote helper/opcodes.js (%d opcodes)', Object.keys(ops).length);
