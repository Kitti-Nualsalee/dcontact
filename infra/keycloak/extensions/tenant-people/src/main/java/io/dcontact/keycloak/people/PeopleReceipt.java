package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Immutable;
@Entity @Immutable @Table(name="DC_TENANT_PEOPLE_RECEIPT")
public class PeopleReceipt {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="OPERATION_KEY",nullable=false,length=64) public String operationKey;
  @Column(name="STEP",nullable=false,length=40) public String step;
  @Column(name="GENERATION",nullable=false) public long generation;
  @Column(name="OUTCOME",nullable=false,length=32) public String outcome;
  @Column(name="REASON_CODE",nullable=false,length=64) public String reasonCode;
  @Column(name="IDENTITY_ID",length=36) public String identityId;
}
