-- J2.9: campaign-target origination barrier needs the same post-admission
-- lifecycle ObCallbackState already has (ORIGINATING/ACTIVE/CONSUMED) — J2.5
-- only modeled ADMITTED/DEFERRED because origination was explicitly out of
-- scope for that ticket.
ALTER TYPE "ObCampaignTargetState" ADD VALUE 'ORIGINATING';
ALTER TYPE "ObCampaignTargetState" ADD VALUE 'ACTIVE';
ALTER TYPE "ObCampaignTargetState" ADD VALUE 'CONSUMED';
