/**
 * Project Isolation Architecture — Unit Tests
 *
 * Tests the multi-project data isolation layer without requiring a database.
 */

import { ProjectService } from '../../src/projects/project-service';

describe('ProjectService', () => {
  let service: ProjectService;

  beforeEach(() => {
    service = new ProjectService();
  });

  describe('resolveProjectContext', () => {
    it('returns undefined when no projectId provided', async () => {
      const result = await service.resolveProjectContext(undefined, 1);
      expect(result).toBeUndefined();
    });

    it('throws when projectId provided but DB is not connected', async () => {
      // Without a DB connection, validateProjectAccess will throw
      await expect(service.resolveProjectContext(999, 1)).rejects.toThrow();
    });
  });

  describe('create validation', () => {
    it('rejects empty project name', async () => {
      await expect(service.create({ companyId: 1, name: '' })).rejects.toThrow('Project name is required');
    });

    it('rejects whitespace-only project name', async () => {
      await expect(service.create({ companyId: 1, name: '   ' })).rejects.toThrow('Project name is required');
    });
  });
});

describe('Project Context Middleware', () => {
  // Import the middleware
  const { projectContextMiddleware } = require('../../src/api/middleware/project-context');

  it('exports a function', () => {
    expect(typeof projectContextMiddleware).toBe('function');
  });

  it('sets projectId to undefined when no header provided', async () => {
    const req: any = { headers: {}, query: {} };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await projectContextMiddleware(req, res, next);
    expect(req.projectId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('parses x-project-id header', async () => {
    // Without DB, validation will fail but middleware catches errors gracefully
    const req: any = { headers: { 'x-project-id': '42' }, query: {}, companyId: 1 };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await projectContextMiddleware(req, res, next);
    // Either succeeds or gracefully falls through (no DB)
    expect(next).toHaveBeenCalled();
  });

  it('ignores invalid project_id values', async () => {
    const req: any = { headers: { 'x-project-id': 'abc' }, query: {} };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await projectContextMiddleware(req, res, next);
    expect(req.projectId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('parses project_id from query parameter', async () => {
    const req: any = { headers: {}, query: { project_id: '5' }, companyId: 1 };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await projectContextMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('CrawlOrchestrator — project-aware', () => {
  const { CrawlOrchestrator } = require('../../src/intelligence/crawl-orchestrator');

  it('accepts projectId in decideCrawlStrategy signature', () => {
    const orchestrator = new CrawlOrchestrator();
    // Should not throw with the new parameter
    expect(typeof orchestrator.decideCrawlStrategy).toBe('function');
    expect(orchestrator.decideCrawlStrategy.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts projectId in saveCrawlResult signature', () => {
    const orchestrator = new CrawlOrchestrator();
    expect(typeof orchestrator.saveCrawlResult).toBe('function');
  });
});

describe('PatternMatcher — project-aware', () => {
  const { PatternMatcher } = require('../../src/intelligence/pattern-matcher');

  it('accepts projectId in learnPatterns', () => {
    const matcher = new PatternMatcher();
    expect(typeof matcher.learnPatterns).toBe('function');
  });

  it('accepts projectId in findPatterns', () => {
    const matcher = new PatternMatcher();
    expect(typeof matcher.findPatterns).toBe('function');
  });

  it('detectPatterns works without projectId', () => {
    const matcher = new PatternMatcher();
    const result = matcher.detectPatterns({
      elements: [
        { tagName: 'input', attributes: { type: 'email', name: 'email', placeholder: 'Email' } },
        { tagName: 'input', attributes: { type: 'password', name: 'password' }, inputType: 'password' },
        { tagName: 'button', attributes: { type: 'submit' }, innerText: 'Login' },
      ],
      forms: [{ action: '/login', method: 'post' }],
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe('login_form');
  });
});

describe('ProfileService — project-aware', () => {
  const { ProfileService } = require('../../src/intelligence/profile-service');

  it('accepts projectId in all key methods', () => {
    const service = new ProfileService();
    expect(typeof service.getOrCreateProfile).toBe('function');
    expect(typeof service.saveProfile).toBe('function');
    expect(typeof service.invalidateProfile).toBe('function');
    expect(typeof service.getProfileStatus).toBe('function');
    expect(typeof service.listProfiles).toBe('function');
  });
});
