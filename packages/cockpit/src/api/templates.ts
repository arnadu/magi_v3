import { api, mp } from "./http";

export interface TemplateSummary {
	id: string;
	name: string;
}

export interface TemplateDetail {
	id: string;
	name: string;
	config: {
		mission: { id: string; name: string; model?: string };
		agents: Array<{
			id: string;
			name?: string;
			role?: string;
			supervisor: string;
		}>;
	};
	teamFiles: Array<{ path: string; content: string }>;
}

export function fetchTemplates(): Promise<TemplateSummary[]> {
	return api<TemplateSummary[]>("/api/templates");
}

export function fetchTemplate(id: string): Promise<TemplateDetail> {
	return api<TemplateDetail>(`/api/templates/${mp(id)}`);
}
