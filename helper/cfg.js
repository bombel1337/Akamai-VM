let opcodes = require('./opcodes.js');

class Block {
    constructor(start) {
        this.start = start;
        this.end = start;
        this.output = [];
        this.term = null;
        this.input = 0;
    }
}

class CFG {
    constructor(entry) {
        this.entry = entry;
        this.blocks = new Map();
        this.predsCache = null;
    }

    succs(block) {
        let term = block.term;
        if (!term) {
            return [];
        }
        if (term.type === 'goto') {
            return [term.target];
        }
        if (term.type === 'branch') {
            return [term.t, term.f];
        }
        return [];
    }

    preds(start) {
        if (!this.predsCache) {
            this.getPreds();
        }
        return this.predsCache.get(start) || [];
    }

    nullify() {
        this.predsCache = null;
    }

    getPreds() {
        this.predsCache = new Map();
        for (let block of this.blocks.values()) {
            for (let succ of this.succs(block)) {
                let list = this.predsCache.get(succ);
                if (list) {
                    list.push(block.start);
                } else {
                    this.predsCache.set(succ, [block.start]);
                }
            }
        }
    }
}

function getBlock(vm, start, end = vm.bytecode.length, leaders = null) {
    let block = new Block(start);
    block.input = vm.stack;
    vm.ptr = start;
    vm.term = null;
    vm.exit = false;

    while (vm.ptr < end) {
        if (vm.term) {
            block.term = vm.term;
            break;
        }
        if (leaders && vm.ptr !== start && leaders.has(vm.ptr)) {
            block.term = {
                type: 'goto',
                target: vm.ptr
            };
            break;
        }

        let op = vm.readByte();
        let handler = opcodes[op];
        if (!handler) {
            block.output.push(`/* unknown op ${op} */`);
            break;
        }

        let res = handler.call(vm);
        if (res) {
            block.output.push(res);
        }
    }

    if (!block.term) {
        if (leaders) {
            block.term = {
                type: 'eof'
            };
        } else {
            block.term = {
                type: 'goto',
                target: end
            };
        }
    }
    block.end = vm.ptr;
    return block;
}

function graph(vm, entry) {
    let cfg = new CFG(entry);
    let leaders = new Set([entry]);
    let queue = [entry];

    while (queue.length) {
        let ptr = queue.shift();
        if (cfg.blocks.has(ptr)) {
            continue;
        }

        let block = getBlock(vm, ptr, vm.bytecode.length, leaders);
        cfg.blocks.set(ptr, block);

        for (let s of cfg.succs(block)) {
            if (!cfg.blocks.has(s) && !leaders.has(s)) {
                leaders.add(s);
                queue.push(s);
            }
        }
    }

    let starts = [...cfg.blocks.keys()].sort((a, b) => a - b);
    for (let start of starts) {
        let block = cfg.blocks.get(start);
        let overlap = starts.find(o => o > block.start && o < block.end);
        if (overlap) {
            vm.stack = block.input;
            cfg.blocks.set(start, getBlock(vm, start, overlap, null));
        }
    }

    return cfg;
}

module.exports = { Block, CFG, graph };