const { structure, indent } = require('./structure.js');
let graph = () => require('./cfg.js').graph;

function binop(operator) {
    return function () {
        let a = this.pop();
        let b = this.pop();
        return this.push(`${a} ${operator} ${b}`);
    };
}

const opcodes = {
    6: function () {
        let value;
        if (this.stack > 0) {
            value = `v${this.stack - 1}`;
        } else if (this.last) {
            value = this.last;
        } else {
            value = 'undefined';
        }
        this.term = {
            type: 'return',
            value
        };
        this.exit = true;
    },

    135: function () {
        this.term = {
            type: 'goto',
            target: this.readInt()
        };
        this.exit = true;
    },

    14: function () {
        let keep = this.readByte();
        let target = this.readInt();
        this.term = {
            type: 'branch',
            cond: this.pop_peek(keep),
            t: target,
            f: this.ptr,
        };
        this.exit = true;
    },

    36: function () {
        let keep = this.readByte();
        let target = this.readInt();
        this.term = {
            type: 'branch',
            cond: `!(${this.pop_peek(keep)})`,
            t: target,
            f: this.ptr,
        };
        this.exit = true;
    },

    147: function () {
        this.term = {
            type: 'eof'
        };
        this.exit = true;
        this.stack = 0;
        this.ptr = this.bytecode.length;
    },

    120: function () {
        this.readByte();
        let tryPtr = this.bytes[this.pop()];
        let catchPtr = this.bytes[this.pop()];
        let finPtr = this.bytes[this.pop()];

        let lift = (entry, pre) => {
            let saved = snapshot(this, [
                'ptr',
                'stack',
                'term',
                'exit',
                'bytes',
                'kinds',
                'last',
                'labels',
                'jumped',
                'fn',
            ]);
            Object.assign(this, {
                bytes: {},
                kinds: {},
                last: null,
                term: null,
                exit: false,
                labels: {},
                jumped: [],
            });
            if (pre) {
                this.push(pre);
            }
            let body = structure(graph()(this, entry));
            Object.assign(this, saved);
            return body;
        };

        let tryBody = '';
        if (tryPtr != null) {
            tryBody = lift(tryPtr);
        }
        let catchBody = '';
        if (catchPtr != null) {
            catchBody = lift(catchPtr, 'err');
        }
        let finBody = '';
        if (finPtr != null) {
            finBody = lift(finPtr);
        }

        return `try {\n${indent(tryBody)}\n} catch (err) {\n${indent(catchBody)}\n} finally {\n${indent(finBody)}\n}`;
    },

    53: function () {
        return this.push('{}');
    },
    112: function () {
        return this.push(this.readStr());
    },
    230: function () {
        return this.push(this.readByte(), true);
    },
    173: function () {
        return this.push(this.readInt(), true);
    },
    158: function () {
        return this.push('undefined');
    },
    71: function () {
        this.pop();
    },

    139: function () {
        let elems = [];
        let count = this.readByte();
        while (count--) {
            switch (this.bytes[this.pop()]) {
                case 0:
                    elems.push(this.pop());
                    break;
                case 1:
                    elems.push(`...${this.pop()}`);
                    break;
            }
        }
        return this.push(`[${elems.join(',')}]`);
    },

    103: function () {
        let raw = this.readStr();
        let res = this.push(`_resolve(${raw})`);
        this.kinds[`v${this.stack - 1}`] = { type: 'box', name: JSON.parse(raw) };
        return res;
    },

    229: function () {
        let key = this.pop();
        let value = this.pop();
        let wrap = this.readByte();
        let kind = this.kinds[key];
        if (kind && kind.type === 'box') {
            let vKind = this.kinds[value];
            let rhs;
            if (vKind && vKind.type === 'box') {
                rhs = vKind.name;
            } else {
                rhs = value;
            }
            let expr = `_${kind.name} = ${rhs}`;
            if (wrap) {
                return this.push(`(${expr})`);
            }
            return expr;
        }
        return `v${this.stack}[${key}] = ${value}`;
    },

    119: function () {
        let sup = this.readByte();
        let key = this.pop();
        let obj = this.pop();
        if (!sup) {
            this.proxy = obj;
        }
        return this.push(`${obj}[${key}]`);
    },

    113: function () {
        this.readByte();
        let argc = this.readByte();
        let entry = this.readInt();

        let saved = snapshot(this, [
            'ptr',
            'stack',
            'argCount',
            'proxy',
            'fn',
            'exit',
            'term',
            'bytes',
            'kinds',
            'last',
            'labels',
            'jumped',
        ]);
        Object.assign(this, {
            stack: 0,
            bytes: {},
            kinds: {},
            last: null,
            fn: true,
            term: null,
            exit: false,
            labels: {},
            jumped: [],
        });
        this.argCount = argc + 1;

        for (let i = 0; i < argc; i++) {
            this.push(null);
        }

        let params = Array.from({ length: argc }, (_, i) => `v${argc - 1 - i}`);
        let body = structure(graph()(this, entry));

        Object.assign(this, saved);
        return this.push(`function(${params.join(', ')}) {\n${indent(body)}\n}`);
    },

    11: function () {
        let res = this.readByte();
        this.readByte();
        let argc = this.readByte();
        let fn = this.pop();
        let args = [];

        for (let i = 0; i < argc; i++) {
            switch (this.bytes[this.pop()]) {
                case 0:
                    args.push(this.pop());
                    break;
                case 1:
                    args.push(`...${this.pop()}.reverse()`);
                    break;
                default:
                    throw new Error('Unknown call argument kind');
            }
        }

        let self = this.getSelf();
        let argList = args.join(', ');
        let call = `${fn}.apply(${self}, [${argList}])`;
        if (self == null || self == fn) {
            call = `${fn}(${argList})`;
        }

        if (res) {
            return this.push(call);
        }
        return call;
    },

    218: function () {
        this.pop();
        let len = this.argCount - 1;
        let top = this.stack;
        let elems = [];
        for (let i = 0; i < len; i++) {
            elems.push(`v${--top}`);
        }
        return `v${this.stack}["arguments"] = [${elems.join(', ')}]`;
    },

    64: function () {
        return this.push(`-1 * ${this.pop()}`);
    },

    94: function () {
        let target = this.pop();
        let incr = this.readByte();
        if (incr > 1) {
            return `${target}++`;
        }
        if (incr === 1) {
            return this.push(`++${target}`);
        }
        return this.push(`${target}++`);
    },

    10: binop('*'),
    34: binop('<'),
    58: binop('<<'),
    72: binop('-'),
    82: binop('!=='),
    97: binop('+'),
    108: binop('/'),
    116: binop('^'),
    128: binop('in'),
    156: binop('==='),
    179: binop('>>'),
    181: binop('%'),
    189: binop('|'),
    201: binop('>>>'),
};


function snapshot(vm, fields) {
    let saved = {};
    for (let field of fields) {
        saved[field] = vm[field];
    }
    return saved;
}

module.exports = opcodes;
