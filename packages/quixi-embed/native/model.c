#include "internal.h"
#include "model_contract.h"
#include "sha256.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static int has_hash(const uint8_t *data,size_t length,const uint8_t hash[32]) {
  uint8_t actual[32];qx_sha256(data,length,actual);return memcmp(actual,hash,32)==0;
}
static const float *weight(const float *const weights[101], const char *name) {
  for(unsigned i=0;i<101;i++) if(strcmp(qx_contract[i].name,name)==0) return weights[i];
  return NULL;
}
static const float *layer_weight(const float *const weights[101], unsigned layer, const char *suffix) {
  char name[96];(void)snprintf(name,sizeof(name),"encoder.layer.%u.%s",layer,suffix);
  return weight(weights,name);
}
qx_model *qx_model_load(const uint8_t *bytes,size_t length,int *status) {
  int code=QX_FORMAT;qx_model *model=NULL;
  const uint16_t endian=1;
  if(status) *status=QX_ARGUMENT;
  if(!bytes||!status) return NULL;
  if(length>QX_MAX_MODEL_BYTES) { *status=QX_LIMIT;return NULL; }
  if(length<256||*(const uint8_t *)&endian!=1) goto fail;
  if(memcmp(bytes,"QXARCTIC",8)!=0) goto fail;
  if(qx_u32(bytes+8)!=1) { code=QX_VERSION;goto fail; }
  if(qx_u32(bytes+12)!=128||qx_u64(bytes+16)!=length||qx_u32(bytes+24)!=4||qx_u32(bytes+28)!=1||
     qx_u64(bytes+96)!=128||qx_u64(bytes+104)!=128) goto fail;
  for(unsigned i=112;i<128;i++) if(bytes[i]) goto fail;
  if(memcmp(bytes+32,qx_source_hash,32)!=0||!has_hash(bytes+128,length-128,bytes+64)) {code=QX_INTEGRITY;goto fail;}
  uint64_t offsets[4],sizes[4],previous=256;
  for(unsigned i=0;i<4;i++) {
    const uint8_t *s=bytes+128+i*32;
    offsets[i]=qx_u64(s+8);sizes[i]=qx_u64(s+16);
    if(qx_u32(s)!=i+1||qx_u32(s+4)!=0||offsets[i]%64||offsets[i]<previous||
       offsets[i]>length||sizes[i]>length-offsets[i]) goto fail;
    uint64_t count=i<2?101:(i==2?30522:1);
    if(qx_u64(s+24)!=count) goto fail;
    previous=offsets[i]+sizes[i];
  }
  if(previous!=length||sizes[0]!=101*96) goto fail;
  const float *weights[101];uint64_t previous_weight=offsets[1];
  for(unsigned i=0;i<101;i++) {
    const uint8_t *record=bytes+offsets[0]+i*96;const qx_tensor_contract *expected=&qx_contract[i];
    size_t name_len=strlen(expected->name);
    if(memcmp(record,expected->name,name_len)!=0) goto fail;
    for(size_t j=name_len;j<64;j++) if(record[j]) goto fail;
    uint64_t offset=qx_u64(record+64),size=qx_u64(record+72);
    if(offset%64||offset<previous_weight||offset<offsets[1]||offset>offsets[1]+sizes[1]||
       size!=expected->bytes||size>offsets[1]+sizes[1]-offset||qx_u32(record+80)!=expected->dim0||
       qx_u32(record+84)!=expected->dim1||qx_u32(record+88)!=expected->rank||qx_u32(record+92)!=1) goto fail;
    if(!has_hash(bytes+offset,(size_t)size,expected->hash)) {code=QX_INTEGRITY;goto fail;}
    weights[i]=(const float *)(bytes+offset);previous_weight=offset+size;
  }
  if(previous_weight!=offsets[1]+sizes[1]) goto fail;
  if(!has_hash(bytes+offsets[2],(size_t)sizes[2],qx_vocabulary_hash)||
     !has_hash(bytes+offsets[3],(size_t)sizes[3],qx_unicode_hash)) {code=QX_INTEGRITY;goto fail;}
  model=(qx_model *)calloc(1,sizeof(*model));
  if(!model) {code=QX_MEMORY;goto fail;}
  model->data=(uint8_t *)malloc(length);
  if(!model->data) {code=QX_MEMORY;goto fail;}
  memcpy(model->data,bytes,length);model->length=length;
  for(unsigned i=0;i<101;i++) weights[i]=(const float *)(model->data+((const uint8_t *)weights[i]-bytes));
  model->word=weight(weights,"embeddings.word_embeddings.weight");
  model->position=weight(weights,"embeddings.position_embeddings.weight");
  model->type=weight(weights,"embeddings.token_type_embeddings.weight");
  model->en_w=weight(weights,"embeddings.LayerNorm.weight");model->en_b=weight(weights,"embeddings.LayerNorm.bias");
  for(unsigned i=0;i<6;i++) {
    qx_layer *l=&model->layer[i];
#define GET(field,name) l->field=layer_weight(weights,i,name)
    GET(qw,"attention.self.query.weight");GET(qb,"attention.self.query.bias");
    GET(kw,"attention.self.key.weight");GET(kb,"attention.self.key.bias");
    GET(vw,"attention.self.value.weight");GET(vb,"attention.self.value.bias");
    GET(ow,"attention.output.dense.weight");GET(ob,"attention.output.dense.bias");
    GET(an_w,"attention.output.LayerNorm.weight");GET(an_b,"attention.output.LayerNorm.bias");
    GET(fw,"intermediate.dense.weight");GET(fb,"intermediate.dense.bias");
    GET(dw,"output.dense.weight");GET(db,"output.dense.bias");
    GET(fn_w,"output.LayerNorm.weight");GET(fn_b,"output.LayerNorm.bias");
#undef GET
  }
  code=qx_vocabulary_init(model,model->data+offsets[2],(size_t)sizes[2]);if(code) goto fail;
  code=qx_unicode_init(model,model->data+offsets[3],(size_t)sizes[3]);if(code) goto fail;
  *status=QX_OK;return model;
fail:
  qx_model_free(model);*status=code;return NULL;
}
void qx_model_free(qx_model *model) { if(model) {free(model->data);memset(model,0,sizeof(*model));free(model);} }
size_t qx_model_bytes(const qx_model *model) {return model?sizeof(*model)+model->length:0;}
const char *qx_status_message(int status) {
  static const char *messages[]={"ok","invalid argument","configured limit exceeded","invalid package format", "unsupported package version",
    "model integrity or identity mismatch","allocation failed","invalid UTF-8","nonfinite output","workspace already in use"};
  return status>=0&&status<10?messages[status]:"unknown status";
}

struct qx_tokenizer { qx_model model; };
qx_tokenizer *qx_tokenizer_load(const uint8_t *bytes,size_t length,int *status) {
  int code=QX_FORMAT;qx_tokenizer *tokenizer=NULL;
  if(status) *status=QX_ARGUMENT;
  if(!bytes||!status) return NULL;
  if(length>2*1024*1024) {code=QX_LIMIT;goto fail;}
  if(length<128||memcmp(bytes,"QXTOKEN1",8)!=0) goto fail;
  if(qx_u32(bytes+8)!=1) {code=QX_VERSION;goto fail;}
  if(qx_u32(bytes+12)!=128||qx_u64(bytes+16)!=length) goto fail;
  for(unsigned i=120;i<128;i++) if(bytes[i]) goto fail;
  uint64_t vocab=qx_u64(bytes+24),vocab_size=qx_u64(bytes+32),unicode=qx_u64(bytes+40),unicode_size=qx_u64(bytes+48);
  if(vocab!=128||vocab_size>length-vocab||unicode%64||unicode<vocab+vocab_size||unicode>length||unicode_size!=length-unicode) goto fail;
  if(memcmp(bytes+56,qx_source_hash,32)||!has_hash(bytes+128,length-128,bytes+88)||
     !has_hash(bytes+vocab,(size_t)vocab_size,qx_vocabulary_hash)||!has_hash(bytes+unicode,(size_t)unicode_size,qx_unicode_hash)) {
    code=QX_INTEGRITY;goto fail;
  }
  tokenizer=(qx_tokenizer *)calloc(1,sizeof(*tokenizer));if(!tokenizer) {code=QX_MEMORY;goto fail;}
  tokenizer->model.data=(uint8_t *)malloc(length);if(!tokenizer->model.data) {code=QX_MEMORY;goto fail;}
  memcpy(tokenizer->model.data,bytes,length);tokenizer->model.length=length;
  code=qx_vocabulary_init(&tokenizer->model,tokenizer->model.data+vocab,(size_t)vocab_size);if(code) goto fail;
  code=qx_unicode_init(&tokenizer->model,tokenizer->model.data+unicode,(size_t)unicode_size);if(code) goto fail;
  *status=QX_OK;return tokenizer;
fail:
  qx_tokenizer_free(tokenizer);*status=code;return NULL;
}
void qx_tokenizer_free(qx_tokenizer *tokenizer) {if(tokenizer) {free(tokenizer->model.data);memset(tokenizer,0,sizeof(*tokenizer));free(tokenizer);}}
size_t qx_tokenizer_bytes(const qx_tokenizer *tokenizer) {return tokenizer?sizeof(*tokenizer)+tokenizer->model.length:0;}
int qx_tokenizer_encode(const qx_tokenizer *tokenizer,const uint8_t *text,size_t length,uint32_t role,uint32_t *ids,uint32_t *count) {
  if(!tokenizer) return QX_ARGUMENT;
  return qx_tokenize(&tokenizer->model,text,length,role,ids,count);
}

int qx_tokenizer_inspect(const qx_tokenizer *tokenizer,const uint8_t *text,size_t length,uint32_t role,uint32_t *count) {
  if(!tokenizer) return QX_ARGUMENT;
  return qx_inspect_tokens(&tokenizer->model,text,length,role,count);
}

int qx_tokenizer_encode_offsets(const qx_tokenizer *tokenizer,const uint8_t *text,size_t length,
                               uint32_t role,qx_token_offset *records,uint32_t capacity,uint32_t *count) {
  if(count)*count=0;
  return tokenizer?qx_tokenize_offsets(&tokenizer->model,text,length,role,records,capacity,count):QX_ARGUMENT;
}
