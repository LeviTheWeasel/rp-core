#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
// Generate a permissive JSON Schema from the TypeScript wire types. Unknown payloads stay {}.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

type Schema = Record<string, unknown>;
const root = join(import.meta.dir, '..');
const sourcePath = join(root, 'src/protocol/commands.ts');
const outputPath = join(root, 'src/protocol/protocol.schema.json');
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const source = program.getSourceFile(sourcePath);
if (!source) throw new Error('commands.ts not in the TypeScript program');

function typeNamed(name: string): ts.Type {
  const declaration = source!.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  if (!declaration) throw new Error(`type ${name} not found`);
  return checker.getTypeAtLocation(declaration.name);
}

function schemaFor(type: ts.Type, active = new Set<number>()): Schema {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) return {};
  if (type.flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === 'true' };
  if (type.flags & ts.TypeFlags.String) return { type: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.isUnion()) {
    const variants = type.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined));
    if (variants.length === 1) return schemaFor(variants[0]!, active);
    return variants.length ? { anyOf: variants.map((part) => schemaFor(part, active)) } : {};
  }
  if (type.isIntersection()) return { allOf: type.types.map((part) => schemaFor(part, active)) };
  if (checker.isArrayType(type)) {
    const item = checker.getTypeArguments(type as ts.TypeReference)[0];
    return { type: 'array', items: item ? schemaFor(item, active) : {} };
  }
  if (checker.isTupleType(type)) {
    const items = checker.getTypeArguments(type as ts.TypeReference).map((part) => schemaFor(part, active));
    return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
  }
  if (!(type.flags & ts.TypeFlags.Object)) return {};
  if (active.has(type.id)) return {};
  active.add(type.id);
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    if (property.name.startsWith('__')) continue;
    const at = property.valueDeclaration ?? property.declarations?.[0] ?? source!;
    const child = checker.getTypeOfSymbolAtLocation(property, at);
    properties[property.name] = schemaFor(child, active);
    if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
  }
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  active.delete(type.id);
  const schema: Schema = { type: 'object' };
  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required;
  if (index) schema.additionalProperties = schemaFor(index, active);
  return schema;
}

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:rp-core:protocol:1',
  title: 'rp-core stdio protocol 1',
  description: 'JSON-RPC requests, responses, and event notifications. Extra fields are allowed for forward compatibility.',
  oneOf: [
    schemaFor(typeNamed('RpcCommand')),
    schemaFor(typeNamed('RpcResponse')),
    schemaFor(typeNamed('RpcEventNotification')),
  ],
};
const output = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== output) throw new Error('protocol.schema.json is stale; run bun tools/generate-protocol-schema.ts');
} else {
  writeFileSync(outputPath, output);
}
