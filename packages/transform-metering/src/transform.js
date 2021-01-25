import * as c from './constants';

// We'd like to import this, but RE2 is cjs
const RE2 = require('re2');

const METER_GENERATED = Symbol('meter-generated');
const getMeterId = 'getMeter';

export function makeMeteringTransformer(
  babelCore,
  {
    overrideParser = undefined,
    overrideRegExp = RE2,
    overrideMeterId = c.DEFAULT_METER_ID,
    overrideSetMeterId = c.DEFAULT_SET_METER_ID,
    overrideRegExpIdPrefix = c.DEFAULT_REGEXP_ID_PREFIX,
  } = {},
) {
  const parser = overrideParser
    ? overrideParser.parse || overrideParser
    : (source, opts) => babelCore.parseSync(source, { parserOpts: opts });
  const meterId = overrideMeterId;
  const replaceGlobalMeterId = overrideSetMeterId;
  const regexpIdPrefix = overrideRegExpIdPrefix;
  let regexpNumber = 0;

  const meteringPlugin = regexpList => ({ types: t }) => {
    // const [[meterId]] = [[getMeterId]]();
    const getMeterDecl = () => {
      const emid = t.Identifier(getMeterId);
      const mid = t.Identifier(meterId);
      emid[METER_GENERATED] = true;
      mid[METER_GENERATED] = true;
      return t.variableDeclaration('const', [
        t.variableDeclarator(mid, t.CallExpression(emid, [])),
      ]);
    };

    // [[meterId]] && [[meterId]][idString](...args)
    const meterCall = (idString, args = []) => {
      const mid = t.Identifier(meterId);
      mid[METER_GENERATED] = true;

      return t.logicalExpression(
        '&&',
        mid,
        t.CallExpression(t.MemberExpression(mid, t.Identifier(idString)), args),
      );
    };

    // Wrap expr with `{ return expr; }` if necessary.
    const blockify = (exprOrBlock, doReturn = false) => {
      switch (exprOrBlock.type) {
        case 'BlockStatement': {
          const { body, directives } = exprOrBlock;
          return t.blockStatement([...body], directives);
        }
        case 'EmptyStatement':
          return t.BlockStatement([]);
        default:
          if (!doReturn) {
            return t.BlockStatement([exprOrBlock]);
          }
          if (exprOrBlock.type === 'ExpressionStatement') {
            return t.BlockStatement([
              t.ReturnStatement(exprOrBlock.expression),
            ]);
          }
          return t.BlockStatement([t.ReturnStatement(exprOrBlock)]);
      }
    };

    // Transform a body into a stack-metered try...finally block.
    const wrapWithStackMeter = tryBlock => {
      const finalizer = t.BlockStatement([
        t.ExpressionStatement(meterCall(c.METER_LEAVE)),
      ]);
      finalizer[METER_GENERATED] = true;
      const newBlock = t.BlockStatement([
        getMeterDecl(),
        t.ExpressionStatement(meterCall(c.METER_ENTER)),
        t.TryStatement(tryBlock, null, finalizer),
      ]);
      return newBlock;
    };

    // Transform a body into a compute-metered block.
    const wrapWithComputeMeter = block => {
      block.body.unshift(t.ExpressionStatement(meterCall(c.METER_COMPUTE)));
      return block;
    };

    const visitor = {
      // Ensure meter identifiers are generated by us, or abort.
      Identifier(path) {
        if (
          (path.node.name === meterId ||
            path.node.name === getMeterId ||
            path.node.name === replaceGlobalMeterId ||
            path.node.name.startsWith(regexpIdPrefix)) &&
          !path.node[METER_GENERATED]
        ) {
          throw path.buildCodeFrameError(
            `Identifier ${path.node.name} is reserved for metering code`,
          );
        }
      },
      RegExpLiteral(path) {
        const { pattern, flags } = path.node;
        const reid = `${regexpIdPrefix}${regexpNumber}`;
        regexpNumber += 1;
        regexpList.push(`\
const ${reid}=RegExp(${JSON.stringify(pattern)},${JSON.stringify(flags)});`);
        const reNode = t.identifier(reid);
        reNode[METER_GENERATED] = true;
        path.replaceWith(reNode);
      },
      // Loop constructs need only a compute meter.
      DoWhileStatement(path) {
        path.node.body = wrapWithComputeMeter(blockify(path.node.body));
      },
      ForStatement(path) {
        path.node.body = wrapWithComputeMeter(blockify(path.node.body));
      },
      ForOfStatement(path) {
        path.node.body = wrapWithComputeMeter(blockify(path.node.body));
      },
      ForInStatement(path) {
        path.node.body = wrapWithComputeMeter(blockify(path.node.body));
      },
      WhileStatement(path) {
        path.node.body = wrapWithComputeMeter(blockify(path.node.body));
      },
      // To prevent interception after exhaustion, wrap catch and finally.
      CatchClause(path) {
        path.node.body = wrapWithComputeMeter(path.node.body);
      },
      TryStatement(path) {
        if (path.node.handler && !t.isCatchClause(path.node.handler)) {
          path.node.handler = wrapWithComputeMeter(path.node.handler);
        }
        if (path.node.finalizer && !path.node.finalizer[METER_GENERATED]) {
          path.node.finalizer = wrapWithComputeMeter(path.node.finalizer);
        }
      },
      // Function definitions need a stack meter, too.
      ArrowFunctionExpression(path) {
        path.node.body = wrapWithStackMeter(blockify(path.node.body, true));
      },
      ClassMethod(path) {
        path.node.body = wrapWithStackMeter(path.node.body);
      },
      FunctionExpression(path) {
        path.node.body = wrapWithStackMeter(path.node.body);
      },
      FunctionDeclaration(path) {
        path.node.body = wrapWithStackMeter(path.node.body);
      },
      ObjectMethod(path) {
        path.node.body = wrapWithStackMeter(path.node.body);
      },
    };
    return { visitor };
  };

  const meteringTransform = {
    rewrite(ss) {
      const { src: source, endowments } = ss;

      if (!endowments[getMeterId]) {
        // This flag turns on the metering.
        return ss;
      }

      // Bill the sources to the meter we'll use later.
      const meter = endowments[getMeterId](true);
      // console.log('got meter from endowments', meter);
      meter && meter[c.METER_COMPUTE](source.length);

      // Do the actual transform.
      const ast = parser(source);
      const regexpList = [];
      const output = babelCore.transformFromAstSync(ast, source, {
        generatorOpts: {
          retainLines: true,
          // Specify `compact: false` to silence:
          // [BABEL] Note: The code generator has deoptimised the styling of
          // undefined as it exceeds the max of 500KB.
          compact: false,
        },
        plugins: [meteringPlugin(regexpList)],
        ast: true,
        code: true,
      });

      // Meter by the regular expressions in use.
      const regexpSource = regexpList.join('');
      const preSource = `const ${meterId}=${getMeterId}();\
${meterId}&&${meterId}.${c.METER_ENTER}();\
try{${regexpSource}`;
      const postSource = `\n}finally{${meterId} && ${meterId}.${c.METER_LEAVE}();}`;

      // Force into an IIFE, if necessary.
      const maybeSource = output.code;
      const actualSource =
        ss.sourceType === 'expression'
          ? `(function(){${preSource}return ${maybeSource}${postSource}})()`
          : `${preSource}${maybeSource}${postSource}`;

      if (overrideRegExp) {
        // By default, override with RE2, which protects against
        // catastrophic backtracking.
        endowments.RegExp = overrideRegExp;
      }

      // console.log('metered source:', `\n${actualSource}`);

      return {
        ...ss,
        ast,
        endowments,
        src: actualSource,
      };
    },
  };

  return meteringTransform;
}
