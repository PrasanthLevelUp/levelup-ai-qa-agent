/**
 * Companies Management Routes
 * GET /api/companies       — List all companies
 * POST /api/companies      — Create a new company
 * GET /api/companies/:id   — Get company details
 * PUT /api/companies/:id   — Update company
 */

import { Router } from 'express';
import { getCompanies, createCompany, getCompanyById, updateCompany } from '../../db/postgres';
import { clearCompanyCache } from '../middleware/company';
import { logger } from '../../utils/logger';

const MOD = 'companies-route';

export function createCompaniesRouter(): Router {
  const router = Router();

  // List all companies
  router.get('/', async (_req, res) => {
    try {
      const companies = await getCompanies();
      res.json({ success: true, data: companies });
    } catch (err) {
      logger.error(MOD, 'Failed to list companies', { error: err });
      res.status(500).json({ success: false, error: 'Failed to list companies' });
    }
  });

  // Create a company
  router.post('/', async (req, res) => {
    try {
      const { name, slug } = req.body;
      if (!name || !slug) {
        res.status(400).json({ success: false, error: 'name and slug are required' });
        return;
      }
      const id = await createCompany(name, slug);
      clearCompanyCache();
      res.json({ success: true, data: { id, name, slug } });
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ success: false, error: 'Company name or slug already exists' });
        return;
      }
      logger.error(MOD, 'Failed to create company', { error: err });
      res.status(500).json({ success: false, error: 'Failed to create company' });
    }
  });

  // Get company by ID
  router.get('/:id', async (req, res) => {
    try {
      const company = await getCompanyById(parseInt(req.params.id, 10));
      if (!company) {
        res.status(404).json({ success: false, error: 'Company not found' });
        return;
      }
      res.json({ success: true, data: company });
    } catch (err) {
      logger.error(MOD, 'Failed to get company', { error: err });
      res.status(500).json({ success: false, error: 'Failed to get company' });
    }
  });

  // Update company
  router.put('/:id', async (req, res) => {
    try {
      const { name, is_active } = req.body;
      await updateCompany(parseInt(req.params.id, 10), { name, is_active });
      clearCompanyCache();
      res.json({ success: true });
    } catch (err) {
      logger.error(MOD, 'Failed to update company', { error: err });
      res.status(500).json({ success: false, error: 'Failed to update company' });
    }
  });

  return router;
}
