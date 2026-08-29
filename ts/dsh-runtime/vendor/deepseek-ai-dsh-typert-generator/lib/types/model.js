/**
 * Compiler-independent Typert analysis model. TypeScript nodes and checker
 * objects are extraction inputs only; emitters consume this graph.
 * @module @deepseek-ai/dsh-typert-generator/model
 */
/**
 * Return the direct type-expression edges owned by one node.
 * @param node - compiler-independent type node to inspect.
 * @returns graph-local ids of its direct child type nodes.
 */
export function childTypeNodeIds(node) {
    switch (node.kind) {
        case 'parenthesized':
        case 'operator': return [node.type];
        case 'reference': return [...node.arguments];
        case 'union':
        case 'intersection': return [...node.types];
        case 'array': return [node.element];
        case 'tuple': return node.elements.map(element => element.type);
        case 'indexed-access': return [node.object, node.index];
        case 'conditional': return [node.check, node.extends, node.whenTrue, node.whenFalse];
        case 'mapped': return [
            ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
            ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
            ...(node.nameType === undefined ? [] : [node.nameType]),
            ...(node.value === undefined ? [] : [node.value]),
        ];
        case 'template-literal': return node.spans.map(span => span.type);
        case 'type-query':
        case 'import-type': return [...node.arguments];
        case 'predicate': return node.type === undefined ? [] : [node.type];
        case 'infer': return [
            ...(node.parameter.constraint === undefined ? [] : [node.parameter.constraint]),
            ...(node.parameter.default === undefined ? [] : [node.parameter.default]),
        ];
        case 'keyword':
        case 'literal':
        case 'object':
        case 'function':
        case 'constructor':
        case 'this': return [];
        default: return assertNever(node);
    }
}
function assertNever(value) {
    throw new Error(`unsupported model variant ${JSON.stringify(value)}`);
}
//# sourceMappingURL=model.js.map