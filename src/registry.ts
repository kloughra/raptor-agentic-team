import * as fs from "fs";
import * as path from "path";

export interface ProjectEntry {
  name: string;
  slug: string;
  description: string;
  path: string;
  createdAt: string;
}

interface RegistryData {
  projects: ProjectEntry[];
}

export class Registry {
  private registryPath: string;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
  }

  async listProjects(): Promise<ProjectEntry[]> {
    const data = this.read();
    return data.projects;
  }

  async findProject(name: string): Promise<ProjectEntry | undefined> {
    const data = this.read();
    return data.projects.find((p) => p.name === name);
  }

  async projectExists(name: string): Promise<boolean> {
    const project = await this.findProject(name);
    return project !== undefined;
  }

  async addProject(entry: ProjectEntry): Promise<void> {
    const data = this.read();
    if (data.projects.some((p) => p.name === entry.name)) {
      throw new Error(
        `Project '${entry.name}' already exists. Use list_projects to see all projects.`
      );
    }
    data.projects.push(entry);
    this.write(data);
  }

  private read(): RegistryData {
    if (!fs.existsSync(this.registryPath)) {
      return { projects: [] };
    }
    const raw = fs.readFileSync(this.registryPath, "utf-8");
    return JSON.parse(raw);
  }

  private write(data: RegistryData): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }
}
