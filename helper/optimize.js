function isPure(expr) {
    return /^(?:"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|undefined|null|true|false|\{\}|\[\]|v\d+|_resolve\("[^"\\]*"\))$/.test(expr.trim());
}

function paranthises(expr) {
    expr = expr.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(expr)) {
        return false;
    }
    if (/^"(?:\\.|[^"\\])*"$/.test(expr)) {
        return false;
    }
    if (expr === 'undefined' || expr === 'null' || expr === 'true' || expr === 'false') {
        return false;
    }
    if (expr === '{}' || expr === '[]') {
        return false;
    }
    if (/^(?:v\d+|_resolve\("[^"\\]*"\)|_[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*|\[[^\[\]]+\]|\([^()]*\))*$/.test(expr)) {
        return false;
    }
    return true;
}

function getNext(lines, start, indent, slot, slots) {
    let slotRe = new RegExp(`\\b${slot}\\b`, 'g');
    let assignRe = new RegExp(`^\\s*${slot}\\s*=(?!=)`);
    let assigners = slots.filter(s => s !== slot).map(s => new RegExp(`^\\s*${s}\\s*=(?!=)`));

    let first = -1;
    let total = 0;

    for (let j = start; j < lines.length; j++) {
        let line = lines[j];
        let leading = line.match(/^(\s*)/)[0];

        if (leading.length < indent.length) {
            break;
        }
        if (leading.length > indent.length) {
            continue;
        }
        if (/^\s*(?:if|while|for|else|return|throw|try|catch|finally|break|continue|do|switch|case|default)\b/.test(line)) {
            break;
        }
        if (/^\s*[{}]/.test(line)) {
            break;
        }

        let isAssign = assignRe.test(line);
        if (/\bfunction\s*\(/.test(line)) {
            if (isAssign) {
                break;
            }
            continue;
        }

        if (first === -1 && assigners.some(re => re.test(line))) {
            break;
        }

        let occ = (line.match(slotRe) || []).length;
        let reads = occ;
        if (isAssign) {
            reads = occ - 1;
        }

        if (reads > 0) {
            if (first === -1) {
                first = j;
            }
            total += reads;
        }
        if (isAssign) {
            break;
        }
    }

    return { line: first, count: total };
}

function replaceSlot(line, slot, replacement) {
    let m = line.match(new RegExp(`^(\\s*)(${slot})(\\s*=(?!=)\\s*)(.*)$`));
    if (m) {
        let [, ws, lhs, eq, rhs] = m;
        let newRhs = rhs.replace(new RegExp(`\\b${slot}\\b`), () => replacement);
        return ws + lhs + eq + newRhs;
    }
    return line.replace(new RegExp(`\\b${slot}\\b`), () => replacement);
}

function inlineSlots(code) {
    let lines = code.split('\n');
    let changed = true;
    let guard = lines.length * 4;

    while (changed && guard-- > 0) {
        changed = false;
        for (let i = 0; i < lines.length; i++) {
            let m = lines[i].match(/^(\s*)(v\d+)\s*=\s*(.+)$/);
            if (!m) {
                continue;
            }
            let [, indent, slot, expr] = m;
            expr = expr.trim();

            let slots = expr.match(/\bv\d+\b/g) || [];
            let use = getNext(lines, i + 1, indent, slot, slots);
            if (use === null) {
                continue;
            }

            if (use.count === 1) {
                let repl;
                if (paranthises(expr)) {
                    repl = `(${expr})`;
                } else {
                    repl = expr;
                }
                lines[use.line] = replaceSlot(lines[use.line], slot, repl);
                lines.splice(i, 1);
                i--;
                changed = true;
                continue;
            }

            if (use.count === 0 && isPure(expr)) {
                lines.splice(i, 1);
                i--;
                changed = true;
            }
        }
    }

    return lines.join('\n').replace(/!\(!\(([^()]+|\([^()]*\))\)\)/g, '$1');
}

function rename(code) {
    return code.replace(/^(\s*)(v\d+)\["([A-Za-z_$][\w$]*)"\]\s*=\s*\2\s*$/gm, '$1_$3 = $2');
}

function renameResolves(code) {
    return code.replace(/_resolve\("([A-Za-z_$][\w$]*)"\)/g, '_$1');
}

function inlineCond(code) {
    let lines = code.split('\n');
    let changed = true;

    while (changed) {
        changed = false;
        for (let i = 0; i < lines.length - 1; i++) {
            let m = lines[i].match(/^(\s*)(v\d+)\s*=\s*(.+)$/);
            if (!m) {
                continue;
            }
            let [, indent, slot, expr] = m;

            let next = lines[i + 1];
            if (!next.match(new RegExp(`^${indent}(if|while)\\s*\\(${slot}\\)\\s*\\{$`))) {
                continue;
            }

            let blockEnd = getEnding(lines, i + 1);
            if (blockEnd === -1) {
                continue;
            }

            let slotRe = new RegExp(`\\b${slot}\\b`);
            let assignRe = new RegExp(`^\\s*${slot}\\s*=(?!=)`);
            let unsafe = false;
            let reAssigned = false;

            for (let j = i + 2; j <= blockEnd && !unsafe; j++) {
                if (!slotRe.test(lines[j])) {
                    continue;
                }
                let occ = (lines[j].match(new RegExp(`\\b${slot}\\b`, 'g')) || []).length;
                let writes = assignRe.test(lines[j]);
                let reads;
                if (writes) {
                    reads = occ - 1;
                } else {
                    reads = occ;
                }
                if (reads > 0) {
                    unsafe = true;
                    break;
                }
                if (writes) {
                    reAssigned = true;
                    break;
                }
            }

            if (!unsafe && !reAssigned) {
                for (let j = blockEnd + 1; j < lines.length; j++) {
                    let leading = lines[j].match(/^(\s*)/)[0];
                    if (leading.length < indent.length) {
                        break;
                    }
                    if (leading.length > indent.length) {
                        continue;
                    }
                    if (assignRe.test(lines[j])) {
                        break;
                    }
                    if (slotRe.test(lines[j])) {
                        unsafe = true;
                        break;
                    }
                }
            }

            if (unsafe) {
                continue;
            }

            lines[i + 1] = next.replace(slot, expr);
            lines.splice(i, 1);
            changed = true;
            break;
        }
    }
    return lines.join('\n');
}

function getEnding(lines, start) {
    let depth = 0;
    for (let c of lines[start]) {
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
        }
    }
    if (depth === 0) {
        return start;
    }
    for (let j = start + 1; j < lines.length; j++) {
        for (let c of lines[j]) {
            if (c === '{') {
                depth++;
            } else if (c === '}') {
                depth--;
            }
        }
        if (depth === 0) {
            return j;
        }
    }
    return -1;
}

function nameFuncs(code) {
    let lines = code.split('\n');
    let out = [];
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];
        let m = line.match(/^(\s*)(v\d+)\s*=\s*function(\s*\([^)]*\)\s*\{)$/);
        if (!m) {
            out.push(line);
            i++;
            continue;
        }
        let [, indent, slot, sig] = m;

        let depth = 1;
        let close = -1;
        for (let j = i + 1; j < lines.length && depth > 0; j++) {
            for (let c of lines[j]) {
                if (c === '{') {
                    depth++;
                } else if (c === '}') {
                    depth--;
                }
            }
            if (depth === 0) {
                close = j;
            }
        }
        if (close === -1) {
            out.push(line);
            i++;
            continue;
        }

        let next = lines[close + 1];
        let alias = next && next.match(new RegExp(`^${indent}(_[A-Za-z_$][\\w$]*)\\s*=\\s*${slot}\\s*$`));
        if (!alias) {
            out.push(line);
            i++;
            continue;
        }
        let name = alias[1];

        let slotRe = new RegExp(`\\b${slot}\\b`);
        let assignRe = new RegExp(`^\\s*${slot}\\s*=(?!=)`);
        let safe = true;
        for (let j = close + 2; j < lines.length; j++) {
            let leading = lines[j].match(/^(\s*)/)[0];
            if (leading.length < indent.length) {
                break;
            }
            if (leading.length > indent.length) {
                continue;
            }
            if (assignRe.test(lines[j])) {
                break;
            }
            if (slotRe.test(lines[j])) {
                safe = false;
                break;
            }
        }
        if (!safe) {
            out.push(line);
            i++;
            continue;
        }

        out.push(`${indent}function ${name}${sig}`);
        for (let j = i + 1; j <= close; j++) {
            out.push(lines[j]);
        }
        i = close + 2;
    }

    return out.join('\n');
}

function optimize(code) {
    code = inlineSlots(code);
    code = rename(code);
    code = renameResolves(code);
    code = inlineSlots(code);
    code = inlineCond(code);
    code = nameFuncs(code);
    return code;
}

module.exports = { optimize };
