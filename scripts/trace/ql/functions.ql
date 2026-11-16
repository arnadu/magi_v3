/**
 * @name Functions of the platform's sources
 * @description Every function: its id, extent, name and the function it is nested in.
 * @kind table
 * @id magi/functions
 */

import javascript

string fnId(Function f) {
  result =
    f.getFile().getRelativePath() + ":" + f.getLocation().getStartLine() + ":" +
      f.getLocation().getStartColumn()
}

string nameOf(Function f) {
  result = f.getName()
  or
  not exists(f.getName()) and result = "(anonymous)"
}

string parentOf(Function f) {
  result = fnId(f.getEnclosingContainer())
  or
  not f.getEnclosingContainer() instanceof Function and result = ""
}

from Function f
where f.getFile().getRelativePath().regexpMatch("packages/[^/]+/src/.*")
select fnId(f) as id, f.getFile().getRelativePath() as file, f.getLocation().getStartLine() as line,
  f.getLocation().getEndLine() as endLine, nameOf(f) as name, parentOf(f) as parent
