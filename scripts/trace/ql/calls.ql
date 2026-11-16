/**
 * @name Call graph of the platform's sources
 * @description Every call CodeQL resolves to a function in the sources: where
 *              the call is, the function it is in, and the function called.
 * @kind table
 * @id magi/calls
 */

import javascript

predicate inSources(Locatable l) { l.getFile().getRelativePath().regexpMatch("packages/[^/]+/src/.*") }

string fnId(Function f) {
  result =
    f.getFile().getRelativePath() + ":" + f.getLocation().getStartLine() + ":" +
      f.getLocation().getStartColumn()
}

string containerId(DataFlow::InvokeNode call) {
  result = fnId(call.getContainer())
  or
  not call.getContainer() instanceof Function and result = "toplevel"
}

from DataFlow::InvokeNode call, Function callee, Expr site
where
  site = call.asExpr() and
  callee = call.getACallee() and
  inSources(site) and
  inSources(callee)
select site.getFile().getRelativePath() as file, site.getLocation().getStartLine() as line,
  site.getLocation().getStartColumn() as col, containerId(call) as caller, fnId(callee) as calleeId
