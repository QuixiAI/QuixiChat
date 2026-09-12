// Supplement to baseline.wgsl: fixed 16x16 output tiles, 16-wide K tiles.
// Only the three frozen projection matrix shapes are dispatched here.
var<workgroup> tile_x:array<f32,256>;
var<workgroup> tile_w:array<f32,256>;
@compute @workgroup_size(8,8)
fn linear_tiled(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) local:vec3u){
  let row=group.y*16u+local.y*2u;let col=group.x*16u+local.x*2u;
  let lane=local.y*8u+local.x;var sums=vec4f(0.0);
  for(var base=0u;base<p.input_width;base+=16u){
    for(var j=lane;j<256u;j+=64u){
      let r=group.y*16u+j/16u;let c=group.x*16u+j/16u;let k=base+j%16u;
      tile_x[j]=0.0;tile_w[j]=0.0;
      if(r<p.batch*p.tokens){tile_x[j]=x[r*p.input_width+k];}
      if(c<p.output_width){tile_w[j]=weights[p.weight+c*p.input_width+k];}
    }
    workgroupBarrier();
    for(var k=0u;k<16u;k++){
      let a=vec2f(tile_x[local.y*32u+k],tile_x[local.y*32u+16u+k]);
      let b=vec2f(tile_w[local.x*32u+k],tile_w[local.x*32u+16u+k]);
      sums+=vec4f(a.x*b.x,a.x*b.y,a.y*b.x,a.y*b.y);
    }
    workgroupBarrier();
  }
  if(row<p.batch*p.tokens){
    if(col<p.output_width){result[row*p.output_width+col]=sums.x+weights[p.bias+col];}
    if(col+1u<p.output_width){result[row*p.output_width+col+1u]=sums.y+weights[p.bias+col+1u];}
  }
  if(row+1u<p.batch*p.tokens){
    if(col<p.output_width){result[(row+1u)*p.output_width+col]=sums.z+weights[p.bias+col];}
    if(col+1u<p.output_width){result[(row+1u)*p.output_width+col+1u]=sums.w+weights[p.bias+col+1u];}
  }
}
