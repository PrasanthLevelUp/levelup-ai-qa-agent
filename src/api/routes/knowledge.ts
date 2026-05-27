/**
 * API Routes for Application Knowledge Management
 * Enterprise-grade knowledge graph for QA intelligence.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  createKnowledgeItem,
  updateKnowledgeItem,
  getKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  searchKnowledgeItems,
  getKnowledgeStats,
  getKnowledgeTags,
  getKnowledgeCategoryDistribution,
  createKnowledgeRelationship,
  getKnowledgeRelationships,
  deleteKnowledgeRelationship,
  suggestKnowledgeItems,
} from '../../db/postgres';

const MOD = 'knowledge-routes';

const VALID_CATEGORIES = [
  'business_rule','workflow','architecture','dependency','integration',
  'automation','manual_test','bug_pattern','domain',
];
const VALID_STATUSES = ['draft','active','archived'];
const VALID_PRIORITIES = ['low','medium','high','critical'];
const VALID_RELATIONSHIP_TYPES = ['depends_on','related_to','implements','blocks','duplicates'];

export function createKnowledgeRouter(): Router {
  const router = Router();

  /* ---- GET / — List knowledge items with filters ---- */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const {
        category, status, priority, tags, module: mod,
        search, limit, offset, page,
        sortBy, sort_by, sortDir, sort_dir,
      } = req.query;

      // Support both camelCase and snake_case sort params
      const effectiveSortBy = (sortBy || sort_by) as string | undefined;
      const effectiveSortDir = (sortDir || sort_dir) as string | undefined;

      // Support page-based pagination (convert page to offset)
      const parsedLimit = limit ? parseInt(String(limit), 10) : undefined;
      let parsedOffset = offset ? parseInt(String(offset), 10) : undefined;
      if (page && !offset) {
        const pageNum = parseInt(String(page), 10);
        if (pageNum > 1) parsedOffset = (pageNum - 1) * (parsedLimit || 50);
      }

      const result = await listKnowledgeItems({
        companyId,
        projectId,
        category: category as string,
        status: (status as string) || undefined,
        priority: priority as string,
        tags: tags ? (Array.isArray(tags) ? tags as string[] : [tags as string]) : undefined,
        module: mod as string,
        search: search as string,
        limit: parsedLimit,
        offset: parsedOffset,
        sortBy: effectiveSortBy,
        sortDir: effectiveSortDir,
      });

      return res.json(result);
    } catch (err: any) {
      logger.error(MOD, 'Failed to list knowledge items', { error: err.message });
      return res.status(500).json({ error: 'Failed to list knowledge items', details: err.message });
    }
  });

  /* ---- GET /stats — Dashboard statistics ---- */
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const stats = await getKnowledgeStats(companyId, projectId);
      return res.json(stats);
    } catch (err: any) {
      logger.error(MOD, 'Failed to get knowledge stats', { error: err.message });
      return res.status(500).json({ error: 'Failed to get stats', details: err.message });
    }
  });

  /* ---- GET /suggest — Suggest relevant knowledge for test generation ---- */
  router.get('/suggest', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const module = req.query.module ? String(req.query.module).trim() : undefined;
      const searchTerm = req.query.searchTerm ? String(req.query.searchTerm).trim() : undefined;
      const category = req.query.category ? String(req.query.category).trim() : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;

      if (!module && !searchTerm && !category) {
        const items = await suggestKnowledgeItems({ companyId, projectId, limit });
        return res.json(items);
      }

      const items = await suggestKnowledgeItems({ companyId, projectId, module, searchTerm, category, limit });
      return res.json(items);
    } catch (err: any) {
      logger.error(MOD, 'Suggest failed', { error: err.message });
      return res.status(500).json({ error: 'Suggest failed', details: err.message });
    }
  });

  /* ---- GET /search — Full-text search ---- */
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const q = String(req.query.q || '').trim();
      if (!q) return res.json([]);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const results = await searchKnowledgeItems(q, companyId, limit, projectId);
      return res.json(results);
    } catch (err: any) {
      logger.error(MOD, 'Search failed', { error: err.message });
      return res.status(500).json({ error: 'Search failed', details: err.message });
    }
  });

  /* ---- GET /tags — All unique tags ---- */
  router.get('/tags', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const tags = await getKnowledgeTags(companyId, projectId);
      return res.json(tags);
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to get tags', details: err.message });
    }
  });

  /* ---- GET /categories — Category distribution ---- */
  router.get('/categories', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const dist = await getKnowledgeCategoryDistribution(companyId, projectId);
      return res.json(dist);
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to get categories', details: err.message });
    }
  });

  /* ---- GET /:id — Single item with relationships ---- */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

      const companyId = (req as any).companyId;
      const item = await getKnowledgeItem(id, companyId);
      if (!item) return res.status(404).json({ error: 'Knowledge item not found' });

      const relationships = await getKnowledgeRelationships(id);
      return res.json({ item, relationships });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get knowledge item', { error: err.message });
      return res.status(500).json({ error: 'Failed to get item', details: err.message });
    }
  });

  /* ---- POST / — Create knowledge item ---- */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const { category, title, description, metadata, tags, relatedModules, status, priority, createdBy } = req.body;

      // Validation
      if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
      if (!description?.trim()) return res.status(400).json({ error: 'description is required' });
      if (!category) return res.status(400).json({ error: 'category is required' });
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (priority && !VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
      }

      const item = await createKnowledgeItem({
        companyId,
        projectId,
        category: category.trim(),
        title: title.trim(),
        description: description.trim(),
        metadata,
        tags: Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : [],
        relatedModules: Array.isArray(relatedModules) ? relatedModules.map((m: string) => m.trim()).filter(Boolean) : [],
        status,
        priority,
        createdBy,
      });

      logger.info(MOD, 'Knowledge item created', { id: item.id, category, companyId });
      return res.status(201).json(item);
    } catch (err: any) {
      logger.error(MOD, 'Failed to create knowledge item', { error: err.message });
      return res.status(500).json({ error: 'Failed to create item', details: err.message });
    }
  });

  /* ---- PUT /:id — Update knowledge item ---- */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

      const companyId = (req as any).companyId;
      const { category, title, description, metadata, tags, relatedModules, status, priority } = req.body;

      // Validate enum fields if provided
      if (category && !VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
      }
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (priority && !VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
      }

      const updated = await updateKnowledgeItem(id, companyId, {
        category,
        title: title?.trim(),
        description: description?.trim(),
        metadata,
        tags: tags !== undefined ? (Array.isArray(tags) ? tags.map((t: string) => t.trim()).filter(Boolean) : []) : undefined,
        relatedModules: relatedModules !== undefined ? (Array.isArray(relatedModules) ? relatedModules.map((m: string) => m.trim()).filter(Boolean) : []) : undefined,
        status,
        priority,
      });

      if (!updated) return res.status(404).json({ error: 'Knowledge item not found or no changes' });

      logger.info(MOD, 'Knowledge item updated', { id, companyId });
      return res.json(updated);
    } catch (err: any) {
      logger.error(MOD, 'Failed to update knowledge item', { error: err.message });
      return res.status(500).json({ error: 'Failed to update item', details: err.message });
    }
  });

  /* ---- DELETE /:id ---- */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

      const companyId = (req as any).companyId;
      const deleted = await deleteKnowledgeItem(id, companyId);
      if (!deleted) return res.status(404).json({ error: 'Knowledge item not found' });

      logger.info(MOD, 'Knowledge item deleted', { id, companyId });
      return res.json({ deleted: true, id });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete knowledge item', { error: err.message });
      return res.status(500).json({ error: 'Failed to delete item', details: err.message });
    }
  });

  /* ---- POST /:id/relationships — Create relationship ---- */
  router.post('/:id/relationships', async (req: Request, res: Response) => {
    try {
      const sourceId = parseInt(String(req.params.id), 10);
      if (isNaN(sourceId)) return res.status(400).json({ error: 'Invalid source ID' });

      const companyId = (req as any).companyId;
      const { targetKnowledgeId, relationshipType, description } = req.body;

      if (!targetKnowledgeId) return res.status(400).json({ error: 'targetKnowledgeId is required' });
      if (!relationshipType) return res.status(400).json({ error: 'relationshipType is required' });
      if (!VALID_RELATIONSHIP_TYPES.includes(relationshipType)) {
        return res.status(400).json({ error: `Invalid relationship type. Must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}` });
      }
      if (sourceId === targetKnowledgeId) {
        return res.status(400).json({ error: 'Cannot create a relationship to itself' });
      }

      // Verify both items exist
      const source = await getKnowledgeItem(sourceId, companyId);
      const target = await getKnowledgeItem(targetKnowledgeId, companyId);
      if (!source) return res.status(404).json({ error: 'Source knowledge item not found' });
      if (!target) return res.status(404).json({ error: 'Target knowledge item not found' });

      const rel = await createKnowledgeRelationship({
        companyId,
        sourceKnowledgeId: sourceId,
        targetKnowledgeId,
        relationshipType,
        description,
      });

      logger.info(MOD, 'Relationship created', { sourceId, targetKnowledgeId, relationshipType });
      return res.status(201).json(rel);
    } catch (err: any) {
      logger.error(MOD, 'Failed to create relationship', { error: err.message });
      return res.status(500).json({ error: 'Failed to create relationship', details: err.message });
    }
  });

  /* ---- DELETE /relationships/:relId — Delete relationship ---- */
  router.delete('/relationships/:relId', async (req: Request, res: Response) => {
    try {
      const relId = parseInt(String(req.params.relId), 10);
      if (isNaN(relId)) return res.status(400).json({ error: 'Invalid relationship ID' });

      const companyId = (req as any).companyId;
      const deleted = await deleteKnowledgeRelationship(relId, companyId);
      if (!deleted) return res.status(404).json({ error: 'Relationship not found' });

      return res.json({ deleted: true, id: relId });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete relationship', details: err.message });
    }
  });

  return router;
}
