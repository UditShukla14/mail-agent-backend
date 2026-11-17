import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCompanyId, normalizePreferredCompanyId, companyOf } from '../../src/services/companies.js';

describe('company selection for Raven billing', () => {
  it('normalizes a preferred company id from a string or header array', () => {
    assert.equal(normalizePreferredCompanyId(' 30000000021 '), '30000000021');
    assert.equal(normalizePreferredCompanyId(['30000000021', 'other']), '30000000021');
    assert.equal(normalizePreferredCompanyId(30000000021), '30000000021');
    assert.equal(normalizePreferredCompanyId(null), '');
    assert.equal(normalizePreferredCompanyId(undefined), '');
    assert.equal(normalizePreferredCompanyId(''), '');
  });

  it('accepts the working company only when it belongs to the user', () => {
    const ids = ['30000000015', '30000000021'];
    assert.equal(acceptedCompanyId(ids, '30000000021'), '30000000021');
    assert.equal(acceptedCompanyId(ids, ' 30000000015 '), '30000000015');
    assert.equal(acceptedCompanyId(ids, '999'), '');
    assert.equal(acceptedCompanyId(ids, ''), '');
    assert.equal(acceptedCompanyId(ids, null), '');
    assert.equal(acceptedCompanyId([], '30000000021'), '');
  });

  it('reads the stored company from a mail user document', () => {
    assert.equal(companyOf({ companyId: '30000000021' }), '30000000021');
    assert.equal(companyOf({ companyId: '  ' }), '');
    assert.equal(companyOf(null), '');
  });
});
