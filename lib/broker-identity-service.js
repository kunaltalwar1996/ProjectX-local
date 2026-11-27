import { supabase } from './supabase.js';

export const ACCEPTED_DOC_TYPES = ['Aadhaar', 'Passport'];
export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const PRIVATE_STORAGE_BUCKET = 'broker-identity-documents';

/**
 * Validates a file on the client before calling prepare upload.
 */
export function validateIdentityFile(file, docType) {
  if (!file) {
    return { valid: false, error: 'Please select a document file to upload.' };
  }
  if (!ACCEPTED_DOC_TYPES.includes(docType)) {
    return { valid: false, error: 'Please select a valid document type (Aadhaar or Passport).' };
  }
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return { valid: false, error: 'Only PDF, JPEG, and PNG document formats are supported.' };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: 'File size exceeds the 10 MB maximum limit.' };
  }
  return { valid: true };
}

/**
 * Fetch current authenticated broker's own verification status.
 */
export async function getOwnVerificationStatus() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Authentication required.');

  try {
    const { data, error } = await supabase.rpc('get_own_broker_verification_status');
    if (error) {
      const isMissing = /could not find the function|schema cache|function.*does not exist/i.test(error.message || '');
      if (isMissing) {
        return {
          status: 'Not Submitted',
          unsupported: true,
          message: 'Verification system awaiting database migration deployment.'
        };
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { status: 'Not Submitted' };

    return {
      status: row.verification_status || (row.is_verified ? 'Verified' : 'Not Submitted'),
      is_verified: Boolean(row.is_verified),
      pending_submission_id: row.pending_submission_id,
      rejection_reason: row.last_rejection_reason || '',
      last_rejected_at: row.last_rejected_at,
      ...row
    };
  } catch (err) {
    console.warn('get_own_broker_verification_status error:', err);
    throw err;
  }
}

/**
 * Submit an identity document:
 * 1. Request upload preparation from backend RPC or Edge Function
 * 2. Upload file directly to authorized storage location in broker-identity-documents
 * 3. Finalize submission via RPC finalize_broker_identity_submission
 */
export async function submitBrokerIdentityDocument(file, docType, onProgress = null) {
  const validation = validateIdentityFile(file, docType);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Authentication required.');

  // 1. Prepare upload via backend
  let prepData;
  try {
    const { data, error } = await supabase.rpc('prepare_broker_identity_upload', {
      p_document_type: docType,
      p_file_name: file.name,
      p_file_type: file.type,
      p_file_size: file.size
    });

    if (error) {
      const isMissing = /could not find the function|schema cache/i.test(error.message || '');
      if (isMissing) {
        throw new Error('Identity verification service is awaiting database deployment. Please apply the migration first.');
      }
      throw error;
    }
    prepData = data;
  } catch (err) {
    throw new Error(err.message || 'Failed to prepare document upload authorization.');
  }

  const storagePath = prepData?.storage_path || prepData?.path || prepData?.expected_object_key;
  const uploadSessionId = prepData?.upload_session_id || prepData?.session_id || prepData?.id || prepData?.token;

  if (!storagePath) {
    throw new Error('Backend did not return an authorized storage path.');
  }

  // 2. Upload directly to private bucket
  if (onProgress) onProgress(30, 'Uploading document securely…');
  try {
    const { error: uploadError } = await supabase.storage
      .from(PRIVATE_STORAGE_BUCKET)
      .upload(storagePath, file, {
        upsert: false,
        contentType: file.type
      });

    if (uploadError) {
      const bucketMissing = /bucket not found|row-level security/i.test(uploadError.message || '');
      if (bucketMissing) {
        throw new Error('Private storage bucket broker-identity-documents is not yet deployed.');
      }
      throw uploadError;
    }
  } catch (err) {
    throw new Error(err.message || 'File upload failed. Please try again.');
  }

  // 3. Finalize submission via backend RPC
  if (onProgress) onProgress(80, 'Finalizing verification request…');
  try {
    // Try passing upload_session_id parameter
    let finalizeData;
    const { data, error } = await supabase.rpc('finalize_broker_identity_submission', {
      p_upload_session_id: uploadSessionId
    });

    if (error) {
      // Fallback with named token/path
      const { data: fbData, error: fbError } = await supabase.rpc('finalize_broker_identity_submission', {
        p_upload_token: uploadSessionId,
        p_document_type: docType,
        p_storage_path: storagePath
      });
      if (fbError) throw fbError;
      finalizeData = fbData;
    } else {
      finalizeData = data;
    }

    if (onProgress) onProgress(100, 'Submitted successfully');
    return finalizeData || { success: true };
  } catch (err) {
    throw new Error(err.message || 'Failed to finalize identity submission.');
  }
}

/**
 * Fetch broker verification history for the authenticated broker.
 */
export async function getBrokerVerificationHistory() {
  try {
    const { data, error } = await supabase.rpc('get_broker_verification_history');
    if (error) {
      console.warn('get_broker_verification_history warning:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Reviewer Operations (Employee 2 and Admin)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the pending identity verification review queue.
 */
export async function getIdentityReviewQueue() {
  try {
    const { data, error } = await supabase.rpc('get_identity_review_queue');
    if (error) {
      const isMissing = /could not find the function|schema cache/i.test(error.message || '');
      if (isMissing) {
        return {
          queue: [],
          unsupported: true,
          message: 'Broker verification review queue RPC awaiting database migration deployment.'
        };
      }
      throw error;
    }
    const rawItems = Array.isArray(data) ? data : [];
    const normalized = rawItems.map(item => ({
      ...item,
      id: item.submission_id || item.id,
      broker_name: item.broker_name || item.full_name || 'ProjectX Broker',
      document_type: item.document_type || 'Identity Document',
      submitted_at: item.submitted_at || item.created_at
    }));
    return { queue: normalized, unsupported: false };
  } catch (err) {
    console.warn('get_identity_review_queue error:', err);
    throw err;
  }
}

/**
 * Request short-lived reviewer document access.
 * Returns temporary signed URL. Does NOT persist anywhere.
 */
export async function requestIdentityDocumentAccess(submissionId) {
  if (!submissionId) throw new Error('Submission ID is required.');
  try {
    const { data, error } = await supabase.rpc('request_identity_document_access', {
      p_submission_id: submissionId
    });
    if (error) throw error;
    const url = typeof data === 'string' ? data : (data?.document_url || data?.signed_url || data?.url);
    if (!url) throw new Error('No access URL returned by server.');
    return url;
  } catch (err) {
    throw new Error(err.message || 'Could not obtain temporary document access URL.');
  }
}

/**
 * Approve a pending broker identity submission.
 */
export async function approveBrokerIdentitySubmission(submissionId) {
  if (!submissionId) throw new Error('Submission ID is required.');
  try {
    const { data, error } = await supabase.rpc('approve_broker_identity_submission', {
      p_submission_id: submissionId
    });
    if (error) throw error;
    return data || { success: true };
  } catch (err) {
    throw new Error(err.message || 'Failed to approve verification submission.');
  }
}

/**
 * Reject a pending broker identity submission. Mandatory non-empty reason required.
 */
export async function rejectBrokerIdentitySubmission(submissionId, reason) {
  if (!submissionId) throw new Error('Submission ID is required.');
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    throw new Error('A mandatory non-empty reason is required to reject a submission.');
  }
  try {
    const { data, error } = await supabase.rpc('reject_broker_identity_submission', {
      p_submission_id: submissionId,
      p_rejection_reason: trimmedReason
    });
    if (error) {
      // Fallback in case parameter was named p_reason
      const { data: fbData, error: fbError } = await supabase.rpc('reject_broker_identity_submission', {
        p_submission_id: submissionId,
        p_reason: trimmedReason
      });
      if (fbError) throw fbError;
      return fbData || { success: true };
    }
    return data || { success: true };
  } catch (err) {
    throw new Error(err.message || 'Failed to reject verification submission.');
  }
}
