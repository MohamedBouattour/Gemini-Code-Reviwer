// Copyright 2026 Google LLC

import {
  parse,
  simpleTraverse,
  type TSESTree,
} from "@typescript-eslint/typescript-estree";
import type {
  ILanguageStrategy,
  FunctionBoundary,
  IdentifierDeclaration,
  StringLiteral,
} from "./ILanguageStrategy.js";

/**
 * TypeScriptStrategy — uses @typescript-eslint/typescript-estree AST.
 * Handles TypeScript, TSX, JavaScript, and JSX.
 */
export class TypeScriptStrategy implements ILanguageStrategy {
  readonly extensions: string[] = [".ts", ".tsx", ".js", ".jsx"];

  extractFunctions(content: string): FunctionBoundary[] {
    try {
      const ast = parse(content, { loc: true, range: true });
      const functions: FunctionBoundary[] = [];
      simpleTraverse(ast, {
        enter: (node: TSESTree.Node) => {
          if (node.type === "FunctionDeclaration" && node.id) {
            functions.push({
              name: node.id.name,
              startLine: node.loc.start.line,
            });
          } else if (
            node.type === "MethodDefinition" &&
            node.key.type === "Identifier"
          ) {
            functions.push({
              name: node.key.name,
              startLine: node.loc.start.line,
            });
          } else if (
            node.type === "VariableDeclarator" &&
            node.id.type === "Identifier" &&
            node.init &&
            (node.init.type === "ArrowFunctionExpression" ||
              node.init.type === "FunctionExpression")
          ) {
            functions.push({
              name: node.id.name,
              startLine: node.loc.start.line,
            });
          }
        },
      });
      return functions;
    } catch {
      return [];
    }
  }

  countDecisionPoints(
    content: string,
    startLine: number,
    endLine: number,
  ): number {
    try {
      // Small optimization: if content is huge, we still parse the whole thing
      // because partial parsing is hard for AST.
      const ast = parse(content, { loc: true, range: true });
      let count = 0;
      simpleTraverse(ast, {
        enter: (node: TSESTree.Node) => {
          if (!node.loc) return;
          if (node.loc.start.line < startLine || node.loc.start.line > endLine)
            return;

          const decisionTypes = [
            "IfStatement",
            "ForStatement",
            "ForInStatement",
            "ForOfStatement",
            "WhileStatement",
            "DoWhileStatement",
            "SwitchCase",
            "CatchClause",
            "ConditionalExpression",
          ];
          if (decisionTypes.includes(node.type)) {
            count++;
          } else if (node.type === "LogicalExpression") {
            if (
              node.operator === "||" ||
              node.operator === "&&" ||
              node.operator === "??"
            ) {
              count++;
            }
          }
        },
      });
      return count;
    } catch {
      return 0;
    }
  }

  extractIdentifiers(content: string): IdentifierDeclaration[] {
    try {
      const ast = parse(content, { loc: true, range: true });
      const idents: IdentifierDeclaration[] = [];
      simpleTraverse(ast, {
        enter: (node: TSESTree.Node) => {
          if (node.type === "ClassDeclaration" && node.id) {
            idents.push({
              name: node.id.name,
              line: node.loc.start.line,
              kind: "class",
            });
          } else if (node.type === "TSInterfaceDeclaration") {
            idents.push({
              name: node.id.name,
              line: node.loc.start.line,
              kind: "interface",
            });
          } else if (node.type === "TSTypeAliasDeclaration") {
            idents.push({
              name: node.id.name,
              line: node.loc.start.line,
              kind: "type",
            });
          } else if (node.type === "TSEnumDeclaration") {
            idents.push({
              name: node.id.name,
              line: node.loc.start.line,
              kind: "enum",
            });
          } else if (node.type === "FunctionDeclaration" && node.id) {
            idents.push({
              name: node.id.name,
              line: node.loc.start.line,
              kind: "function",
            });
          } else if (node.type === "VariableDeclaration") {
            const kind = node.kind === "const" ? "constant" : "variable";
            for (const decl of node.declarations) {
              if (decl.id.type === "Identifier") {
                idents.push({
                  name: decl.id.name,
                  line: node.loc.start.line,
                  kind,
                });
              }
            }
          }
        },
      });
      return idents;
    } catch {
      return [];
    }
  }

  extractStringLiterals(content: string): StringLiteral[] {
    try {
      const ast = parse(content, { loc: true, range: true });
      const literals: StringLiteral[] = [];
      simpleTraverse(ast, {
        enter: (node: TSESTree.Node) => {
          if (node.type === "Literal" && typeof node.value === "string") {
            literals.push({ value: node.value, line: node.loc.start.line });
          } else if (node.type === "TemplateLiteral") {
            const val = node.quasis
              .map((q: TSESTree.TemplateElement) => q.value.cooked)
              .join("");
            literals.push({ value: val, line: node.loc.start.line });
          }
        },
      });
      return literals;
    } catch {
      return [];
    }
  }

  stripCommentsAndImports(content: string): string {
    try {
      const ast = parse(content, {
        loc: true,
        range: true,
        comment: true,
      });
      const rangesToRemove: [number, number][] = [];

      simpleTraverse(ast, {
        enter: (node: TSESTree.Node) => {
          if (node.type === "ImportDeclaration") {
            rangesToRemove.push(node.range);
          }
        },
      });

      if (ast.comments) {
        for (const comment of ast.comments) {
          rangesToRemove.push(comment.range);
        }
      }

      // Sort ranges descending to avoid index shifts
      rangesToRemove.sort((a, b) => b[0] - a[0]);

      let optimized = content;
      for (const [start, end] of rangesToRemove) {
        optimized = optimized.slice(0, start) + optimized.slice(end);
      }

      // Metadata: Clean up SVG paths (generic requirement)
      optimized = optimized.replace(
        /(<svg\b[^>]*>)(.*?)(<\/svg>)/gs,
        (_match, p1, _p2, p3) => p1 + p3,
      );

      return optimized.replace(/\s+/g, " ").trim();
    } catch {
      // Fallback
      return content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(?<!https?:)\/\/.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
}
