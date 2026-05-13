let fs = require('fs');
let { VM, decode } = require('./helper/vm.js');
let { graph } = require('./helper/cfg.js');
let { structure } = require('./helper/structure.js');
let { optimize } = require('./helper/optimize.js');

function decompile(bytecode) {
    let vm = new VM(decode(bytecode));
    return optimize(structure(graph(vm, 0)));
}

let bytecode = fs.readFileSync('./script/bytecode.txt', 'utf8');
let st = Date.now();
let de = decompile(bytecode);
console.log(`Decompiled in ${Date.now() - st}ms`);
fs.writeFileSync('./output/ak.js', de);