#include "../native/quixi_embed.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void checked(qx_tokenizer *tokenizer,const uint8_t *text,size_t length,
                    uint32_t role,uint32_t capacity,int expected,uint32_t needed) {
  uint32_t allocated=capacity>=2&&capacity<=65536?capacity:2;
  uint32_t *storage=malloc((size_t)allocated*24+8);assert(storage);
  storage[0]=storage[allocated*6+1]=0xa5a5a5a5u;
  uint32_t count=0xa5a5a5a5u;
  int status=qx_tokenizer_encode_offsets(tokenizer,text,length,role,(qx_token_offset *)(storage+1),capacity,&count);
  assert(status==expected&&count==needed);
  assert(storage[0]==0xa5a5a5a5u&&storage[allocated*6+1]==0xa5a5a5a5u);
  if(status==QX_OK){
    qx_token_offset *records=(qx_token_offset *)(storage+1);
    assert(records[0].id==101&&records[0].origin==QX_FRAMING);
    assert(records[count-1].id==102&&records[count-1].origin==QX_FRAMING);
  }
  free(storage);
}

int main(int argc,char **argv) {
  assert(argc==2);FILE *file=fopen(argv[1],"rb");assert(file);
  assert(!fseek(file,0,SEEK_END));long size=ftell(file);assert(size>0&&size<=2*1024*1024);rewind(file);
  uint8_t *blob=malloc((size_t)size);assert(blob);assert(fread(blob,1,(size_t)size,file)==(size_t)size);fclose(file);
  int status;qx_tokenizer *tokenizer=qx_tokenizer_load(blob,(size_t)size,&status);assert(tokenizer&&status==QX_OK);free(blob);
  uint8_t *text=malloc(QX_MAX_TEXT_BYTES+1u);assert(text);memset(text,'.',QX_MAX_TEXT_BYTES+1u);
  checked(tokenizer,NULL,0,QX_DOCUMENT,2,QX_OK,2);
  checked(tokenizer,NULL,0,QX_QUERY,2,QX_LIMIT,10);
  checked(tokenizer,text,65534,QX_DOCUMENT,65536,QX_OK,65536);
  checked(tokenizer,text,QX_MAX_TEXT_BYTES,QX_DOCUMENT,65536,QX_LIMIT,QX_MAX_TEXT_BYTES+2);
  checked(tokenizer,text,QX_MAX_TEXT_BYTES,QX_QUERY,65536,QX_LIMIT,QX_MAX_TEXT_BYTES+10);
  checked(tokenizer,text,QX_MAX_TEXT_BYTES,QX_QUERY,2,QX_LIMIT,QX_MAX_TEXT_BYTES+10);
  checked(tokenizer,text,QX_MAX_TEXT_BYTES+1u,QX_DOCUMENT,2,QX_LIMIT,0);
  for(unsigned i=0;i<32;i++)checked(tokenizer,text,65534,QX_DOCUMENT,65536,QX_OK,65536);
  checked(tokenizer,text,1,QX_DOCUMENT,0,QX_ARGUMENT,0);
  checked(tokenizer,text,1,QX_DOCUMENT,1,QX_ARGUMENT,0);
  checked(tokenizer,text,1,QX_DOCUMENT,65537,QX_ARGUMENT,0);
  checked(tokenizer,text,1,QX_DOCUMENT,UINT32_MAX,QX_ARGUMENT,0);
  checked(tokenizer,text,1,UINT32_MAX,2,QX_ARGUMENT,0);
  checked(tokenizer,NULL,1,QX_DOCUMENT,2,QX_ARGUMENT,0);
  checked(NULL,text,1,QX_DOCUMENT,2,QX_ARGUMENT,0);
  text[QX_MAX_TEXT_BYTES-1]=0xc0;
  checked(tokenizer,text,QX_MAX_TEXT_BYTES,QX_QUERY,2,QX_UTF8,0);
  uint32_t count=7;assert(qx_tokenizer_encode_offsets(tokenizer,text,1,QX_DOCUMENT,NULL,2,&count)==QX_ARGUMENT&&count==0);
  qx_token_offset records[8];
  memset(text,'a',QX_MAX_TEXT_BYTES);
  assert(qx_tokenizer_encode_offsets(tokenizer,text,QX_MAX_TEXT_BYTES,QX_DOCUMENT,records,8,&count)==QX_OK&&count==3);
  assert(records[1].id==100&&records[1].byte_end==QX_MAX_TEXT_BYTES&&records[1].utf16_end==QX_MAX_TEXT_BYTES);
  assert(qx_tokenizer_encode_offsets(tokenizer,(const uint8_t *)"[CLS]",5,QX_DOCUMENT,records,8,&count)==QX_OK&&count==3);
  assert(records[1].id==101&&records[1].origin==QX_SOURCE&&records[1].byte_start==0&&records[1].byte_end==5);
  assert(qx_tokenizer_encode_offsets(tokenizer,(const uint8_t *)"\xea\xb0\x81",3,QX_DOCUMENT,records,8,&count)==QX_OK&&count==5);
  for(unsigned i=1;i<4;i++)assert(records[i].byte_start==0&&records[i].byte_end==3&&records[i].utf16_start==0&&records[i].utf16_end==1);
  free(text);qx_tokenizer_free(tokenizer);puts("Offset capacity, provenance, UTF-8 and full cleanup checks passed");return 0;
}
