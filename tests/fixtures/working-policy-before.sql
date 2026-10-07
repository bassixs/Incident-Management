INSERT INTO "User" (id,"maxUserId","displayName","updatedAt") VALUES ('policy-control-user',999001,'Synthetic',now());
INSERT INTO "Incident" (id,"publicCode","requesterId","requesterMaxUserId","requesterName",text,"createdAt","deadlineAt","updatedAt","isOverdue","slaReminder24SentAt")
VALUES ('policy-control','SYNTHETIC-CONTROL','policy-control-user',999001,'Synthetic','Synthetic data','2026-09-01 10:01:02.123','2026-09-04 14:00:00',now(),true,'2026-09-02 10:01:02.123');
INSERT INTO "SystemSetting" (key,value,"updatedAt") VALUES ('synthetic-policy-migration-control',jsonb_build_object(
  'incident',(SELECT to_jsonb(i) FROM "Incident" i WHERE id='policy-control'),
  'migrations',(SELECT jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name) FROM "_prisma_migrations")),now());
