/**
 * Jest-only shim for the "os" module (wired via moduleNameMapper).
 *
 * Why: tsconfig has `esModuleInterop: true`, so `import * as os from "os"`
 * compiles to `__importStar(require("os"))`. For a CJS module without the
 * `__esModule` marker, __importStar builds a namespace COPY whose properties
 * are non-configurable getters — `jest.spyOn(os, "homedir")` then throws
 * "Cannot redefine property: homedir".
 *
 * Marking this shim `__esModule: true` makes __importStar return the module
 * object AS-IS (no frozen copy), so its plain, configurable properties are
 * spyable. The spread copies every real `os` export unchanged.
 *
 * The "node:os" specifier is intentionally NOT mapped, so Node internals and
 * any code using the prefixed form get the untouched builtin.
 */
const os = require("node:os");

module.exports = { __esModule: true, ...os };
