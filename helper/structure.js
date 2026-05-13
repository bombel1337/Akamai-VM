let { revPostOrder, getDominators, getLoops } = require('./dominators.js');

function structure(cfg) {
    let rpo = revPostOrder(cfg);
    if (!rpo.length) {
        return '';
    }
    let dom = getDominators(cfg, rpo);
    let loops = getLoops(cfg, dom);
    let ctx = {
        cfg,
        dom,
        loops,
        emitted: new Set(),
        loopStack: [],
    };
    return emit(ctx, cfg.entry, null);
}

function emit(ctx, start, stopAt) {
    let lines = [];
    let ptr = start;

    while (ptr !== null && ptr !== stopAt) {
        let idx = ctx.loopStack.findIndex(l => l.header === ptr || l.exit === ptr);
        if (idx !== -1) {
            let loop = ctx.loopStack[idx];
            let todo = 'break';
            if (ptr === loop.header) {
                todo = 'continue';
            }
            if (idx === ctx.loopStack.length - 1) {
                lines.push(`${todo};`);
            }
            break;
        }

        ctx.emitted.add(ptr);

        let block = ctx.cfg.blocks.get(ptr);

        if (ctx.loops.has(ptr)) {
            ptr = emitLoop(ctx, ptr, block, lines);
            continue;
        }

        lines.push(...block.output);

        let term = block.term;
        if (term.type === 'eof') {
            break;
        }
        if (term.type === 'return') {
            lines.push(`return ${term.value};`);
            break;
        }
        if (term.type === 'goto') {
            ptr = term.target;
            continue;
        }
        if (term.type === 'branch') {
            ptr = emitBranch(ctx, ptr, term, lines);
            if (ptr === null) {
                break;
            }
            continue;
        }
        break;
    }

    return lines.join('\n');
}

function emitLoop(ctx, header, block, lines) {
    let body = ctx.loops.get(header);
    let term = block.term;
    let exit = null;
    let cond = null;
    let entry = null;

    if (term && term.type === 'branch') {
        if (body.has(term.t) && !body.has(term.f)) {
            exit = term.f;
            cond = term.cond;
            entry = term.t;
        } else if (body.has(term.f) && !body.has(term.t)) {
            exit = term.t;
            cond = `!(${term.cond})`;
            entry = term.f;
        }
    }

    if (exit === null) {
        for (let n of body) {
            let edge = ctx.cfg.succs(ctx.cfg.blocks.get(n)).find(s => !body.has(s));
            if (edge !== undefined) {
                exit = edge;
                break;
            }
        }
    }

    ctx.loopStack.push({ header, exit, label: `L${header}` });

    if (cond && entry) {
        if (block.output.length) {
            lines.push(...block.output);
        }
        lines.push(
            `while (${cond}) {`,
            indent(emit(ctx, entry, header)),
            `}`,
        );
    } else {
        let _body = [...block.output];
        if (term.type === 'goto') {
            _body.push(emit(ctx, term.target, null));
        } else if (term.type === 'branch') {
            _body.push(
                `if (${term.cond}) {`,
                indent(emit(ctx, term.t, null)),
                `} else {`,
                indent(emit(ctx, term.f, null)),
                `}`,
            );
        }
        lines.push(
            `L${header}: while (true) {`,
            indent(_body.join('\n')),
            `}`,
        );
    }

    ctx.loopStack.pop();
    return exit;
}

function emitBranch(ctx, ptr, term, lines) {
    let merge = getMP(ctx, ptr, term.t, term.f);

    if (term.t === merge && term.f !== merge) {
        lines.push(
            `if (!(${term.cond})) {`,
            indent(emit(ctx, term.f, merge)),
            `}`,
        );
    } else if (term.f === merge && term.t !== merge) {
        lines.push(
            `if (${term.cond}) {`,
            indent(emit(ctx, term.t, merge)),
            `}`,
        );
    } else {
        lines.push(
            `if (${term.cond}) {`,
            indent(emit(ctx, term.t, merge)),
            `} else {`,
            indent(emit(ctx, term.f, merge)),
            `}`,
        );
    }

    return merge;
}

function getMP(ctx, ptr, truthy, falsey) {
    let idx = ctx.dom.idx.get(ptr) ?? -1;

    function reach(start) {
        let res = new Set();
        if ((ctx.dom.idx.get(start) ?? -1) <= idx) {
            return res;
        }
        let queue = [start];
        while (queue.length) {
            let n = queue.shift();
            if (res.has(n)) {
                continue;
            }
            res.add(n);
            let block = ctx.cfg.blocks.get(n);
            if (!block) {
                continue;
            }
            for (let succ of ctx.cfg.succs(block)) {
                if ((ctx.dom.idx.get(succ) ?? -1) > idx) {
                    queue.push(succ);
                }
            }
        }
        return res;
    }

    let tReach = reach(truthy);
    tReach.add(truthy);
    let fReach = reach(falsey);
    fReach.add(falsey);

    let common = [...tReach].filter(x => fReach.has(x));
    if (!common.length) {
        return null;
    }
    common.sort((a, b) => (ctx.dom.idx.get(a) ?? 0) - (ctx.dom.idx.get(b) ?? 0));
    return common[0];
}

function indent(text, width = 4) {
    if (!text) {
        return '';
    }
    let pad = ' '.repeat(width);
    return text.split('\n').map(line => {
        if (line) {
            return pad + line;
        }
        return line;
    }).join('\n');
}

module.exports = { structure, indent };