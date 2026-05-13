function decode(b64) {
    return [...Buffer.from(b64, 'base64')];
}

class VM {
    constructor(bytecode) {
        this.bytecode = bytecode;
        this.ptr = 0;
        this.stack = 0;
        this.argCount = 0;
        this.self = null;
        this.fn = false;
        this.exit = false;
        this.term = null;
        this.labels = {};
        this.jumped = [];
        this.bytes = {};
        this.kinds = {};
        this.last = null;
    }

    readByte() {
        return this.bytecode[this.ptr++];
    }

    readInt() {
        let a = this.readByte();
        let b = this.readByte();
        let c = this.readByte();
        let d = this.readByte();
        return (a << 24) | (b << 16) | (c << 8) | d;
    }

    readStr() {
        let len = (this.readByte() << 8) | this.readByte();
        let str = '';
        for (let i = 0; i < len; i++) {
            str += String.fromCharCode(this.readByte());
        }
        return JSON.stringify(str);
    }

    push(v, t) {
        let slot = `v${this.stack}`;
        delete this.kinds[slot];
        this.last = slot;
        if (t) {
            this.bytes[slot] = v;
        }
        return `v${this.stack++} = ${v}`;
    }

    peek() {
        return `v${this.stack - 1}`;
    }

    pop() {
        let v = this.peek();
        this.stack--;
        return v;
    }

    pop_peek(x) {
        if (x) {
            return this.peek();
        }
        return this.pop();
    }

    getSelf() {
        let prev = this.self;
        this.self = null;
        return prev;
    }
}

module.exports = { VM, decode };
