export interface NotionPageSummary {
  pageId: string;
  title: string;
  url?: string;
  createdTime?: string;
  lastEditedTime?: string;
  parentType?: string;
  parentId?: string;
}

export interface NotionPageContent extends NotionPageSummary {
  text: string;
  blocks: string[];
}

export interface NotionWriteSummary extends NotionPageSummary {
  summary: string;
}
