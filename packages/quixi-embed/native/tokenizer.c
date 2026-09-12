#include "internal.h"
#include <string.h>
_Static_assert(sizeof(qx_token_offset)==24,"Offset ABI uses six uint32 fields");
_Static_assert(QX_MAX_TEXT_BYTES<=(UINT32_MAX-10u)/3u,"Frozen normalization token count fits uint32");

static uint32_t hash_bytes(const uint8_t *bytes,size_t length) {
  uint32_t hash=2166136261u;for(size_t i=0;i<length;i++) hash=(hash^bytes[i])*16777619u;return hash;
}
int qx_vocabulary_init(qx_model *model,const uint8_t *data,size_t length) {
  model->vocab=data;size_t start=0;uint32_t count=0;
  for(size_t i=0;i<length;i++) if(data[i]=='\n') {
    if(count>=QX_VOCAB||i==start||i-start>65535) return QX_FORMAT;
    model->vocab_offsets[count]=(uint32_t)start;model->vocab_lengths[count]=(uint16_t)(i-start);
    uint32_t slot=hash_bytes(data+start,i-start)&(QX_HASH_SLOTS-1);
    while(model->vocab_hash[slot]) slot=(slot+1)&(QX_HASH_SLOTS-1);
    model->vocab_hash[slot]=count+1;count++;start=i+1;
  }
  return count==QX_VOCAB&&start==length?QX_OK:QX_FORMAT;
}
static int vocabulary(const qx_model *model,const uint8_t *bytes,size_t length) {
  uint32_t slot=hash_bytes(bytes,length)&(QX_HASH_SLOTS-1);
  for(unsigned probe=0;probe<QX_HASH_SLOTS;probe++) {
    uint32_t found=model->vocab_hash[slot];if(!found) return -1;
    uint32_t id=found-1;
    if(model->vocab_lengths[id]==length&&memcmp(model->vocab+model->vocab_offsets[id],bytes,length)==0) return (int)id;
    slot=(slot+1)&(QX_HASH_SLOTS-1);
  }
  return -1;
}
static int valid_ranges(const uint8_t *data,uint32_t count) {
  uint32_t previous=0;
  for(uint32_t i=0;i<count;i++) {uint32_t a=qx_u32(data+i*8),b=qx_u32(data+i*8+4);
    if(a>b||b>0x10ffff||(i&&a<=previous)) return 0;previous=b;}
  return 1;
}
int qx_unicode_init(qx_model *model,const uint8_t *data,size_t length) {
  if(length<24||memcmp(data,"QXUNIC01",8)) return QX_FORMAT;
  uint32_t deletes=qx_u32(data+8),maps=qx_u32(data+12),puncts=qx_u32(data+16),pool=qx_u32(data+20);
  uint64_t required=24ull+deletes*8ull+maps*12ull+puncts*8ull+pool;
  if(required!=length||deletes>0x110000||maps>0x110000||puncts>0x110000) return QX_FORMAT;
  model->deletion=data+24;model->deletion_count=deletes;
  model->mapping=model->deletion+deletes*8ull;model->mapping_count=maps;
  model->punctuation=model->mapping+maps*12ull;model->punctuation_count=puncts;
  model->utf8=model->punctuation+puncts*8ull;model->utf8_size=pool;
  if(!valid_ranges(model->deletion,deletes)||!valid_ranges(model->punctuation,puncts)) return QX_FORMAT;
  uint32_t previous=0;
  for(uint32_t i=0;i<maps;i++) {
    const uint8_t *m=model->mapping+i*12;uint32_t cp=qx_u32(m),offset=qx_u32(m+4),size=qx_u32(m+8);
    if(cp>0x10ffff||(i&&cp<=previous)||offset>pool||size>pool-offset) return QX_FORMAT;previous=cp;
  }
  return QX_OK;
}
static int in_ranges(const uint8_t *data,uint32_t count,uint32_t cp) {
  uint32_t begin=0,end=count;
  while(begin<end) {uint32_t mid=begin+(end-begin)/2;const uint8_t *r=data+mid*8;
    if(cp<qx_u32(r)) end=mid;else if(cp>qx_u32(r+4)) begin=mid+1;else return 1;}
  return 0;
}
static int cjk(uint32_t cp) {
  return (cp>=0x4e00&&cp<=0x9fff)||(cp>=0x3400&&cp<=0x4dbf)||(cp>=0x20000&&cp<=0x2a6df)||
    (cp>=0x2a700&&cp<=0x2b73f)||(cp>=0x2b740&&cp<=0x2b81f)||(cp>=0x2b920&&cp<=0x2ceaf)||
    (cp>=0xf900&&cp<=0xfaff)||(cp>=0x2f800&&cp<=0x2fa1f);
}
static int decode(const uint8_t *bytes,size_t length,size_t *cursor,uint32_t *cp) {
  if(*cursor>=length) return QX_UTF8;uint8_t b=bytes[(*cursor)++];
  if(b<0x80) {*cp=b;return QX_OK;}
  unsigned continuation;uint32_t value,minimum;
  if(b>=0xc2&&b<=0xdf) {continuation=1;value=b&31;minimum=0x80;}
  else if(b>=0xe0&&b<=0xef) {continuation=2;value=b&15;minimum=0x800;}
  else if(b>=0xf0&&b<=0xf4) {continuation=3;value=b&7;minimum=0x10000;}
  else return QX_UTF8;
  if(continuation>length-*cursor) return QX_UTF8;
  for(unsigned i=0;i<continuation;i++) {uint8_t next=bytes[(*cursor)++];if((next&0xc0)!=0x80) return QX_UTF8;value=(value<<6)|(next&63);}
  if(value<minimum||value>0x10ffff||(value>=0xd800&&value<=0xdfff)) return QX_UTF8;
  *cp=value;return QX_OK;
}
static unsigned encode(uint32_t cp,uint8_t out[4]) {
  if(cp<0x80) {out[0]=(uint8_t)cp;return 1;}
  if(cp<0x800) {out[0]=(uint8_t)(0xc0|(cp>>6));out[1]=(uint8_t)(0x80|(cp&63));return 2;}
  if(cp<0x10000) {out[0]=(uint8_t)(0xe0|(cp>>12));out[1]=(uint8_t)(0x80|((cp>>6)&63));out[2]=(uint8_t)(0x80|(cp&63));return 3;}
  out[0]=(uint8_t)(0xf0|(cp>>18));out[1]=(uint8_t)(0x80|((cp>>12)&63));out[2]=(uint8_t)(0x80|((cp>>6)&63));out[3]=(uint8_t)(0x80|(cp&63));return 4;
}
typedef struct {uint32_t byte_start,byte_end,utf16_start,utf16_end;} source_span;
typedef struct {
  const qx_model *model;uint32_t *ids,count,characters,bytes,limit;uint8_t word[400];
  qx_token_offset *offsets;source_span *alignment,first,last;uint32_t origin;
} tokenizer;
static void emit(tokenizer *state,uint32_t id,source_span span,uint32_t origin) {
  if(state->count<state->limit) {
    if(state->offsets) state->offsets[state->count]=(qx_token_offset){id,span.byte_start,span.byte_end,span.utf16_start,span.utf16_end,origin};
    else state->ids[state->count]=id;
  }
  /* Frozen normalization expands a scalar into at most three scalars. At the
     1 MiB input ceiling the full count, including query framing, fits uint32. */
  if(state->offsets||state->count<state->limit) state->count++;
}
static void emit_word(tokenizer *state,uint32_t id,uint32_t begin,uint32_t end,int unknown) {
  source_span span={0};
  if(state->alignment) {
    source_span first=unknown?state->first:state->alignment[begin];
    source_span last=unknown?state->last:state->alignment[end-1];
    span=(source_span){first.byte_start,last.byte_end,first.utf16_start,last.utf16_end};
  }
  emit(state,id,span,state->origin);
}
static void flush(tokenizer *state) {
  if(!state->characters) return;
  if(state->characters>100) {emit_word(state,100,0,0,1);state->characters=state->bytes=0;return;}
  uint32_t pieces[100],starts[100],ends[100],piece_count=0;size_t start=0;int unknown=0;
  while(start<state->bytes) {
    size_t end=state->bytes;int found=-1;uint8_t candidate[402];
    while(end>start) {
      size_t prefix=start?2:0;if(prefix) {candidate[0]='#';candidate[1]='#';}
      memcpy(candidate+prefix,state->word+start,end-start);
      found=vocabulary(state->model,candidate,prefix+end-start);if(found>=0) break;
      end--;while(end>start&&(state->word[end]&0xc0)==0x80) end--;
    }
    if(found<0) {piece_count=1;pieces[0]=100;starts[0]=0;ends[0]=state->bytes;unknown=1;break;}
    starts[piece_count]=(uint32_t)start;ends[piece_count]=(uint32_t)end;
    pieces[piece_count++]=(uint32_t)found;start=end;
  }
  for(uint32_t i=0;i<piece_count;i++) emit_word(state,pieces[i],starts[i],ends[i],unknown);state->characters=state->bytes=0;
}
static void normalized_cp(tokenizer *state,uint32_t cp,source_span span) {
  if(cp==' ') {flush(state);return;}
  int boundary=cjk(cp)||in_ranges(state->model->punctuation,state->model->punctuation_count,cp);
  if(boundary) flush(state);
  if(state->alignment) {if(!state->characters)state->first=span;state->last=span;}
  state->characters++;
  if(state->characters<=100) {uint8_t bytes[4];unsigned count=encode(cp,bytes);memcpy(state->word+state->bytes,bytes,count);
    if(state->alignment) for(unsigned i=0;i<count;i++) state->alignment[state->bytes+i]=span;
    state->bytes+=count;}
  if(boundary) flush(state);
}
static int process(tokenizer *state,const uint8_t *text,size_t length,uint32_t origin) {
  static const char *specials[]={"[PAD]","[UNK]","[CLS]","[SEP]","[MASK]"};
  static const uint32_t special_ids[]={0,100,101,102,103};
  size_t cursor=0;uint32_t utf16=0;state->origin=origin;
  while(cursor<length&&(state->offsets||state->count<state->limit)) {
    int special=0;
    if(text[cursor]=='[') for(unsigned i=0;i<5;i++) {
      size_t size=strlen(specials[i]);
      if(size<=length-cursor&&memcmp(text+cursor,specials[i],size)==0) {
        flush(state);emit(state,special_ids[i],(source_span){(uint32_t)cursor,(uint32_t)(cursor+size),utf16,utf16+(uint32_t)size},origin);
        cursor+=size;utf16+=(uint32_t)size;special=1;break;
      }
    }
    if(special) continue;
    size_t byte_start=cursor;uint32_t utf16_start=utf16,cp;int status=decode(text,length,&cursor,&cp);if(status) return status;
    utf16+=cp>0xffff?2:1;source_span span={(uint32_t)byte_start,(uint32_t)cursor,utf16_start,utf16};
    if(in_ranges(state->model->deletion,state->model->deletion_count,cp)) continue;
    uint32_t begin=0,end=state->model->mapping_count;const uint8_t *mapping=NULL;
    while(begin<end) {uint32_t mid=begin+(end-begin)/2;const uint8_t *entry=state->model->mapping+mid*12;
      uint32_t key=qx_u32(entry);if(cp<key) end=mid;else if(cp>key) begin=mid+1;else {mapping=entry;break;}}
    if(mapping) {
      uint32_t offset=qx_u32(mapping+4),size=qx_u32(mapping+8);size_t pos=0;
      while(pos<size) {status=decode(state->model->utf8+offset,size,&pos,&cp);if(status) return QX_FORMAT;normalized_cp(state,cp,span);}
    } else normalized_cp(state,cp,span);
  }
  return QX_OK;
}
static int tokenize_bounded(const qx_model *model,const uint8_t *text,size_t length,uint32_t role,uint32_t *ids,uint32_t *count,uint32_t limit) {
  if(!model||(!text&&length)||!ids||!count||(role!=QX_DOCUMENT&&role!=QX_QUERY)) return QX_ARGUMENT;
  if(length>QX_MAX_TEXT_BYTES) return QX_LIMIT;
  size_t cursor=0;uint32_t cp;
  while(cursor<length) {int status=decode(text,length,&cursor,&cp);if(status) return status;}
  tokenizer state={0};state.model=model;state.ids=ids;state.limit=limit;ids[0]=101;state.count=1;
  static const uint8_t prefix[]="Represent this sentence for searching relevant passages: ";
  if(role==QX_QUERY) {int status=process(&state,prefix,sizeof(prefix)-1,QX_QUERY_PREFIX);if(status) return status;}
  int status=process(&state,text,length,QX_SOURCE);if(status) return status;flush(&state);
  ids[state.count++]=102;*count=state.count;return QX_OK;
}

int qx_tokenize(const qx_model *model,const uint8_t *text,size_t length,uint32_t role,uint32_t *ids,uint32_t *count) {
  return tokenize_bounded(model,text,length,role,ids,count,511);
}
/* One extra content token proves overflow while preserving a bounded scan/output.
   Count includes CLS/SEP and the role prefix, saturating at 513. */
int qx_inspect_tokens(const qx_model *model,const uint8_t *text,size_t length,uint32_t role,uint32_t *count) {
  uint32_t ids[513];return tokenize_bounded(model,text,length,role,ids,count,512);
}

int qx_tokenize_offsets(const qx_model *model,const uint8_t *text,size_t length,uint32_t role,
                        qx_token_offset *records,uint32_t capacity,uint32_t *count) {
  if(count)*count=0;
  if(!model||(!text&&length)||!records||!count||(role!=QX_DOCUMENT&&role!=QX_QUERY)||
     capacity<2||capacity>QX_MAX_OFFSET_TOKENS)return QX_ARGUMENT;
  if(length>QX_MAX_TEXT_BYTES)return QX_LIMIT;
  source_span alignment[400];tokenizer state={0};state.model=model;state.offsets=records;
  state.alignment=alignment;state.limit=capacity;
  emit(&state,101,(source_span){0},QX_FRAMING);
  static const uint8_t prefix[]="Represent this sentence for searching relevant passages: ";
  if(role==QX_QUERY){int status=process(&state,prefix,sizeof(prefix)-1,QX_QUERY_PREFIX);if(status)return status;}
  int status=process(&state,text,length,QX_SOURCE);if(status)return status;flush(&state);
  emit(&state,102,(source_span){0},QX_FRAMING);*count=state.count;
  return state.count>capacity?QX_LIMIT:QX_OK;
}
