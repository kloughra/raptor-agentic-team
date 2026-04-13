import * as fs from "fs";
import * as path from "path";

const DEFAULT_MAX_SIZE = 30 * 1024;     // 30KB total
const DEFAULT_MAX_PER_FILE = 3 * 1024;  // 3KB per file

const BINARY_EXTENSIONS = /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz|bmp|mp3|mp4|avi|mov|exe|dll|so|dylib|o|class|jar|war|node_modules)$/i;

const ALWAYS_EXCLUDED = new Set([
  ".git", "node_modules", "dist", "build", "target", "__pycache__",
  ".next", ".nuxt", "coverage", ".nyc_output",
]);

export interface CodebaseContextConfig {
  maxSize?: number;
  maxPerFile?: number;
  excludePatterns?: string[];
}

export interface ModuleExport {
  path: string;
  exports: string[];
}

export interface FileExcerpt {
  path: string;
  content: string;
}

export interface CodebaseSnapshot {
  directoryTree: string;
  moduleExports: ModuleExport[];
  keyFileExcerpts: FileExcerpt[];
  dependencies: string[];
  totalSize: number;
}

/**
 * Extract exported names from file content based on language.
 */
export function extractExports(content: string, filePath: string): string[] {
  const exports: string[] = [];

  if (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    // TypeScript / JavaScript exports
    const patterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+class\s+(\w+)/g,
      /export\s+const\s+(\w+)/g,
      /export\s+let\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+type\s+(\w+)/g,
      /export\s+enum\s+(\w+)/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        exports.push(match[1]);
      }
    }
  } else if (filePath.endsWith(".py")) {
    // Python: top-level def and class
    const lines = content.split("\n");
    for (const line of lines) {
      const defMatch = line.match(/^def\s+(\w+)\s*\(/);
      if (defMatch) exports.push(defMatch[1]);
      const classMatch = line.match(/^class\s+(\w+)[\s:(]/);
      if (classMatch) exports.push(classMatch[1]);
    }
  }

  return exports;
}

/**
 * Parse .gitignore file and return patterns for basic matching.
 */
function loadGitignorePatterns(projectPath: string): string[] {
  const gitignorePath = path.join(projectPath, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];

  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Check if a file/directory name matches any gitignore pattern (basic matching).
 */
function matchesGitignore(name: string, relativePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/\/$/, ""); // strip trailing slash

    // Exact name match
    if (name === cleanPattern) return true;

    // Simple glob: *.ext
    if (cleanPattern.startsWith("*.")) {
      const ext = cleanPattern.slice(1);
      if (name.endsWith(ext)) return true;
    }

    // Directory match: pattern/
    if (pattern.endsWith("/") && name === cleanPattern) return true;

    // Path contains pattern
    if (relativePath.includes(cleanPattern)) return true;
  }
  return false;
}

/**
 * Build a filtered directory tree string.
 */
function buildFilteredTree(
  dirPath: string,
  projectPath: string,
  gitignorePatterns: string[],
  maxDepth: number,
  currentDepth: number = 0,
  prefix: string = ""
): string {
  if (currentDepth >= maxDepth) return "";

  const lines: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath)
      .filter((e) => {
        if (e.startsWith(".")) return false;
        if (ALWAYS_EXCLUDED.has(e)) return false;
        const relativePath = path.relative(projectPath, path.join(dirPath, e));
        if (matchesGitignore(e, relativePath, gitignorePatterns)) return false;
        return true;
      })
      .sort();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = path.join(dirPath, entry);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          lines.push(`${prefix}${connector}${entry}/`);
          const children = buildFilteredTree(
            fullPath, projectPath, gitignorePatterns,
            maxDepth, currentDepth + 1, prefix + childPrefix
          );
          if (children) lines.push(children);
        } else {
          lines.push(`${prefix}${connector}${entry}`);
        }
      } catch {
        // skip inaccessible
      }
    }
  } catch {
    // skip unreadable
  }

  return lines.join("\n");
}

/**
 * Collect source files recursively, respecting exclusions.
 */
function collectSourceFiles(
  dirPath: string,
  projectPath: string,
  gitignorePatterns: string[],
  maxDepth: number = 5,
  currentDepth: number = 0
): string[] {
  if (currentDepth >= maxDepth) return [];

  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (ALWAYS_EXCLUDED.has(entry)) continue;

      const fullPath = path.join(dirPath, entry);
      const relativePath = path.relative(projectPath, fullPath);
      if (matchesGitignore(entry, relativePath, gitignorePatterns)) continue;
      if (BINARY_EXTENSIONS.test(entry)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...collectSourceFiles(fullPath, projectPath, gitignorePatterns, maxDepth, currentDepth + 1));
        } else if (stat.isFile()) {
          files.push(fullPath);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }

  return files;
}

/**
 * Detect dependencies from package manifests.
 */
function detectDependencies(projectPath: string): string[] {
  const deps: string[] = [];

  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies));
      if (pkg.devDependencies) deps.push(...Object.keys(pkg.devDependencies));
    } catch { /* skip */ }
  }

  const cargoPath = path.join(projectPath, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, "utf-8");
      const depMatches = content.match(/^\s*(\w[\w-]*)\s*=/gm);
      if (depMatches) {
        for (const m of depMatches) {
          const name = m.trim().split(/\s*=/)[0].trim();
          if (name !== "name" && name !== "version" && name !== "edition") {
            deps.push(name);
          }
        }
      }
    } catch { /* skip */ }
  }

  return deps;
}

/**
 * Build a codebase snapshot for agent context injection.
 */
export function buildCodebaseSnapshot(
  projectPath: string,
  config?: CodebaseContextConfig
): CodebaseSnapshot {
  const maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
  const maxPerFile = config?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  let totalSize = 0;

  const gitignorePatterns = loadGitignorePatterns(projectPath);
  const userExcludes = config?.excludePatterns ?? [];
  const allPatterns = [...gitignorePatterns, ...userExcludes];

  // 1. Directory tree (2 levels)
  const directoryTree = buildFilteredTree(projectPath, projectPath, allPatterns, 3);
  totalSize += directoryTree.length;

  // 2. Collect source files and extract exports
  const moduleExports: ModuleExport[] = [];
  const keyFileExcerpts: FileExcerpt[] = [];

  const sourceFiles = collectSourceFiles(projectPath, projectPath, allPatterns);
  const sourceExtensions = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs"]);

  for (const fullPath of sourceFiles) {
    if (totalSize >= maxSize) break;

    const ext = path.extname(fullPath);
    if (!sourceExtensions.has(ext)) continue;

    const relativePath = path.relative(projectPath, fullPath);

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const truncated = content.slice(0, maxPerFile);

      // Extract exports
      const exports = extractExports(truncated, relativePath);
      if (exports.length > 0) {
        const exportEntry = { path: relativePath, exports };
        const exportSize = relativePath.length + exports.join(", ").length;
        if (totalSize + exportSize < maxSize) {
          moduleExports.push(exportEntry);
          totalSize += exportSize;
        }
      }

      // Key file excerpts (entry points and important files)
      if (isKeyFile(relativePath)) {
        const excerptContent = truncated.slice(0, maxPerFile);
        if (totalSize + excerptContent.length < maxSize) {
          keyFileExcerpts.push({ path: relativePath, content: excerptContent });
          totalSize += excerptContent.length;
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  // 3. Dependencies
  const dependencies = detectDependencies(projectPath);
  totalSize += dependencies.join(", ").length;

  return {
    directoryTree,
    moduleExports,
    keyFileExcerpts,
    dependencies,
    totalSize,
  };
}

/**
 * Check if a file is a "key file" worth excerpting.
 */
function isKeyFile(relativePath: string): boolean {
  const keyPatterns = [
    /^src\/index\.(ts|js|tsx|jsx)$/,
    /^src\/main\.(ts|js|tsx|jsx)$/,
    /^src\/app\.(ts|js|tsx|jsx)$/,
    /^app\.(py|ts|js)$/,
    /^main\.(py|ts|js|rs)$/,
    /^src\/lib\.rs$/,
    /^src\/tools\.(ts|js)$/,
    /^src\/config\.(ts|js)$/,
  ];

  return keyPatterns.some((p) => p.test(relativePath));
}

/**
 * Format a codebase snapshot as a markdown section for prompt injection.
 */
export function formatSnapshotForPrompt(snapshot: CodebaseSnapshot): string {
  const sections: string[] = [];

  sections.push("## Codebase Context");
  sections.push("*Current state of the project codebase. Use this to understand existing patterns and structure.*\n");

  sections.push("### Directory Tree");
  sections.push("```");
  sections.push(snapshot.directoryTree || "(empty project)");
  sections.push("```\n");

  if (snapshot.moduleExports.length > 0) {
    sections.push("### Module Exports");
    for (const mod of snapshot.moduleExports) {
      sections.push(`- **${mod.path}**: ${mod.exports.join(", ")}`);
    }
    sections.push("");
  }

  if (snapshot.keyFileExcerpts.length > 0) {
    sections.push("### Key Files");
    for (const file of snapshot.keyFileExcerpts) {
      sections.push(`#### ${file.path}`);
      sections.push("```");
      sections.push(file.content);
      sections.push("```\n");
    }
  }

  if (snapshot.dependencies.length > 0) {
    sections.push("### Dependencies");
    sections.push(snapshot.dependencies.join(", "));
    sections.push("");
  }

  return sections.join("\n");
}
