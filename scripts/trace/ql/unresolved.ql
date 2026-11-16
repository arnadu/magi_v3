/**
 * @name Calls the call graph could not resolve
 * @description Calls with no resolved callee whose name is the name of a
 *              function in the sources: where `reach` may be incomplete,
 *              typically a call through an injected dependency.
 * @kind table
 * @id magi/unresolved
 */

import javascript

string containerId(DataFlow::InvokeNode call) {
  exists(Function f | f = call.getContainer() |
    result =
      f.getFile().getRelativePath() + ":" + f.getLocation().getStartLine() + ":" +
        f.getLocation().getStartColumn()
  )
  or
  not call.getContainer() instanceof Function and result = "toplevel"
}

from DataFlow::InvokeNode call, Expr site, string name
where
  site = call.asExpr() and
  site.getFile().getRelativePath().regexpMatch("packages/[^/]+/src/.*") and
  not exists(call.getACallee()) and
  name = call.getCalleeName() and
  exists(Function f |
    f.getName() = name and f.getFile().getRelativePath().regexpMatch("packages/[^/]+/src/.*")
  )
select site.getFile().getRelativePath() as file, site.getLocation().getStartLine() as line,
  containerId(call) as caller, name
