import * as fs from 'fs';
import * as path from 'path';
import { Table } from './mapping';
import { getEmbedding } from './llm';
import { log } from './logger';

const CACHE_FILE = path.resolve(process.cwd(), 'embeddings-cache.json');

interface EmbeddingEntry {
  tableName: string;
  text: string;
  embedding: number[];
  updatedAt: string;
}

export class RAGSystem {
  private index: EmbeddingEntry[] = [];

  constructor() {
    this.loadCache();
  }

  private loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
      try {
        this.index = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      } catch (e) {
        console.error('Failed to load embeddings cache', e);
        this.index = [];
      }
    }
  }

  private saveCache() {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(this.index, null, 2));
  }

  private tableToText(table: Table): string {
    return `Table: ${table.name}
Comment: ${table.comment || ''}
Description: ${table.llm_description || ''}
Category: ${table.llm_category || ''}
Columns: ${table.columns.map(c => `${c.name} (${c.data_type})`).join(', ')}`;
  }

  async indexTables(tables: Table[]) {
    let changed = false;
    log.info(`Indexing ${tables.length} tables for RAG...`);

    for (const table of tables) {
      const text = this.tableToText(table);
      const existing = this.index.find(e => e.tableName === table.name);

      if (existing && existing.text === text) {
        continue;
      }

      try {
        log.info(`Generating embedding for ${table.name}...`);
        const embedding = await getEmbedding(text);

        this.index = this.index.filter(e => e.tableName !== table.name);
        
        this.index.push({
          tableName: table.name,
          text,
          embedding,
          updatedAt: new Date().toISOString()
        });
        changed = true;
      } catch (e) {
        console.error(`Failed to embed table ${table.name}`, e);
      }
    }

    if (changed) {
      this.saveCache();
    }
    log.info('RAG Indexing complete.');
  }

  async search(query: string, topK: number = 5): Promise<{ table: string; score: number; description: string }[]> {
    if (this.index.length === 0) return [];

    const queryEmbedding = await getEmbedding(query);
    
    const results = this.index.map(entry => {
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
      return {
        table: entry.tableName,
        score,
        description: entry.text
      };
    });

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export const ragSystem = new RAGSystem();
