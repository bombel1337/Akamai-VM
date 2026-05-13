function revPostOrder(cfg) {
    let order = [];
    let seen = new Set();

    function visit(start) {
        if (seen.has(start)) {
            return;
        }
        seen.add(start);
        let block = cfg.blocks.get(start);
        if (!block) {
            return;
        }
        for (let succ of cfg.succs(block)) {
            visit(succ);
        }
        order.push(start);
    }

    visit(cfg.entry);
    return order.reverse();
}

function getDominators(cfg, rpo) {
    let idx = new Map(rpo.map((start, i) => [start, i]));
    let doms = new Array(rpo.length).fill(-1);
    doms[0] = 0;

    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 1; i < rpo.length; i++) {
            let preds = cfg.preds(rpo[i]).map(p => idx.get(p)).filter(p => p !== undefined && doms[p] !== -1);
            if (!preds.length) {
                continue;
            }

            let _dom = preds[0];
            for (let j = 1; j < preds.length; j++) {
                _dom = intersect(doms, _dom, preds[j]);
            }
            if (doms[i] !== _dom) {
                doms[i] = _dom;
                changed = true;
            }
        }
    }
    return { doms, idx, rpo };
}

function intersect(doms, a, b) {
    while (a !== b) {
        while (a > b) {
            a = doms[a];
        }
        while (b > a) {
            b = doms[b];
        }
    }
    return a;
}

function dominates(dom, aStart, bStart) {
    if (!dom.idx.has(aStart) || !dom.idx.has(bStart)) {
        return false;
    }
    let a = dom.idx.get(aStart);
    let cur = dom.idx.get(bStart);
    while (true) {
        if (cur === a) {
            return true;
        }
        if (dom.doms[cur] === cur) {
            return false;
        }
        cur = dom.doms[cur];
    }
}

function getLoops(cfg, dom) {
    let headers = new Map();
    for (let block of cfg.blocks.values()) {
        for (let succ of cfg.succs(block)) {
            if (!dominates(dom, succ, block.start)) {
                continue;
            }

            if (!headers.has(succ)) {
                headers.set(succ, new Set([succ]));
            }
            let body = headers.get(succ);
            let stack = [block.start];
            while (stack.length) {
                let n = stack.pop();
                if (body.has(n)) {
                    continue;
                }
                body.add(n);
                for (let p of cfg.preds(n)) {
                    if (p !== succ) {
                        stack.push(p);
                    }
                }
            }
        }
    }
    return headers;
}

module.exports = { revPostOrder, getDominators, dominates, getLoops };
