// canvas_ity replay renderer for the comparison matrix.
//
// Reads one op stream (see record_ops.js for the format) from a file,
// replays it through canvas_ity, and writes the resulting canvas as raw
// unpremultiplied RGBA8 bytes (width*height*4, top-to-bottom rows).
//
// Usage: render_canvasity <font.ttf> <case.ops> <out.rgba>
//
// This file is part of the comparison harness only; it does not modify
// the library under test.

#define CANVAS_ITY_IMPLEMENTATION
#include "../src/canvas_ity.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace canvas_ity;

namespace {

struct gradient {
    bool radial = false;
    float coords[ 6 ] = {};
    struct stop { float offset, r, g, b, a; };
    std::vector< stop > stops;
};

std::vector< unsigned char > read_file( char const *path ) {
    std::ifstream in( path, std::ios::binary );
    if ( !in ) {
        std::cerr << "cannot open " << path << "\n";
        std::exit( 1 );
    }
    return std::vector< unsigned char >(
        ( std::istreambuf_iterator< char >( in ) ),
        std::istreambuf_iterator< char >() );
}

std::string hex_to_utf8( std::string const &hex ) {
    std::string out;
    for ( size_t i = 0; i + 1 < hex.size(); i += 2 )
        out += static_cast< char >( std::stoi( hex.substr( i, 2 ), 0, 16 ) );
    return out;
}

} // namespace

int main( int argc, char **argv ) {
    if ( argc != 4 ) {
        std::cerr <<
            "usage: render_canvasity <font.ttf> <case.ops> <out.rgba>\n";
        return 2;
    }
    std::vector< unsigned char > font = read_file( argv[ 1 ] );
    std::ifstream ops( argv[ 2 ] );
    if ( !ops ) {
        std::cerr << "cannot open " << argv[ 2 ] << "\n";
        return 1;
    }

    std::unique_ptr< canvas > ctx;
    int canvas_w = 0, canvas_h = 0;
    std::map< int, gradient > gradients;
    std::string line;
    int lineno = 0;
    while ( std::getline( ops, line ) ) {
        ++lineno;
        if ( line.empty() ) continue;
        std::istringstream in( line );
        std::string op;
        in >> op;
        auto num = [ & ]() { float v; in >> v; return v; };
        if ( op == "canvas" ) {
            in >> canvas_w >> canvas_h;
            ctx.reset( new canvas( canvas_w, canvas_h ) );
        } else if ( !ctx ) {
            std::cerr << "op before canvas at line " << lineno << "\n";
            return 1;
        } else if ( op == "save" ) { ctx->save();
        } else if ( op == "restore" ) { ctx->restore();
        } else if ( op == "beginPath" ) { ctx->begin_path();
        } else if ( op == "closePath" ) { ctx->close_path();
        } else if ( op == "fill" ) { ctx->fill();
        } else if ( op == "stroke" ) { ctx->stroke();
        } else if ( op == "clip" ) { ctx->clip();
        } else if ( op == "moveTo" ) {
            float x = num(), y = num();
            ctx->move_to( x, y );
        } else if ( op == "lineTo" ) {
            float x = num(), y = num();
            ctx->line_to( x, y );
        } else if ( op == "quadraticCurveTo" ) {
            float a = num(), b = num(), c = num(), d = num();
            ctx->quadratic_curve_to( a, b, c, d );
        } else if ( op == "bezierCurveTo" ) {
            float a = num(), b = num(), c = num(), d = num(), e = num(), f = num();
            ctx->bezier_curve_to( a, b, c, d, e, f );
        } else if ( op == "arc" ) {
            float x = num(), y = num(), r = num(), a0 = num(), a1 = num();
            int ccw = 0;
            in >> ccw;
            ctx->arc( x, y, r, a0, a1, ccw != 0 );
        } else if ( op == "arcTo" ) {
            float x1 = num(), y1 = num(), x2 = num(), y2 = num(), r = num();
            ctx->arc_to( x1, y1, x2, y2, r );
        } else if ( op == "rect" ) {
            float x = num(), y = num(), w = num(), h = num();
            ctx->rectangle( x, y, w, h );
        } else if ( op == "fillRect" ) {
            float x = num(), y = num(), w = num(), h = num();
            ctx->fill_rectangle( x, y, w, h );
        } else if ( op == "strokeRect" ) {
            float x = num(), y = num(), w = num(), h = num();
            ctx->stroke_rectangle( x, y, w, h );
        } else if ( op == "setTransform" ) {
            float a = num(), b = num(), c = num(), d = num(), e = num(), f = num();
            ctx->set_transform( a, b, c, d, e, f );
        } else if ( op == "translate" ) {
            float x = num(), y = num();
            ctx->translate( x, y );
        } else if ( op == "rotate" ) { ctx->rotate( num() );
        } else if ( op == "scale" ) {
            float x = num(), y = num();
            ctx->scale( x, y );
        } else if ( op == "transform" ) {
            float a = num(), b = num(), c = num(), d = num(), e = num(), f = num();
            ctx->transform( a, b, c, d, e, f );
        } else if ( op == "fillColor" || op == "strokeColor" ) {
            float r = num(), g = num(), b = num(), a = num();
            ctx->set_color(
                op == "fillColor" ? fill_style : stroke_style,
                r / 255.0f, g / 255.0f, b / 255.0f, a / 255.0f );
        } else if ( op == "linearGradient" || op == "radialGradient" ) {
            gradient g;
            g.radial = op == "radialGradient";
            int id = 0;
            in >> id;
            int n = g.radial ? 6 : 4;
            for ( int i = 0; i < n; ++i ) in >> g.coords[ i ];
            gradients[ id ] = g;
        } else if ( op == "colorStop" ) {
            int id = 0;
            in >> id;
            gradient::stop s;
            in >> s.offset >> s.r >> s.g >> s.b >> s.a;
            gradients[ id ].stops.push_back( s );
        } else if ( op == "fillGradient" || op == "strokeGradient" ) {
            int id = 0;
            in >> id;
            gradient const &g = gradients[ id ];
            brush_type type = op == "fillGradient" ? fill_style : stroke_style;
            if ( g.radial )
                ctx->set_radial_gradient( type,
                    g.coords[ 0 ], g.coords[ 1 ], g.coords[ 2 ],
                    g.coords[ 3 ], g.coords[ 4 ], g.coords[ 5 ] );
            else
                ctx->set_linear_gradient( type,
                    g.coords[ 0 ], g.coords[ 1 ], g.coords[ 2 ], g.coords[ 3 ] );
            for ( auto const &s : g.stops )
                ctx->add_color_stop( type, s.offset,
                    s.r / 255.0f, s.g / 255.0f, s.b / 255.0f, s.a / 255.0f );
        } else if ( op == "lineWidth" ) { ctx->set_line_width( num() );
        } else if ( op == "lineCap" ) {
            std::string v; in >> v;
            ctx->line_cap =
                v == "round" ? circle : v == "square" ? square : butt;
        } else if ( op == "lineJoin" ) {
            std::string v; in >> v;
            ctx->line_join =
                v == "round" ? rounded : v == "bevel" ? bevel : miter;
        } else if ( op == "miterLimit" ) { ctx->set_miter_limit( num() );
        } else if ( op == "lineDashOffset" ) {
            ctx->line_dash_offset = num();
        } else if ( op == "setLineDash" ) {
            int n = 0;
            in >> n;
            std::vector< float > segs( n );
            for ( auto &s : segs ) in >> s;
            ctx->set_line_dash( segs.data(), n );
        } else if ( op == "globalAlpha" ) { ctx->set_global_alpha( num() );
        } else if ( op == "font" ) {
            float size = num();
            ctx->set_font( font.data(),
                static_cast< int >( font.size() ), size );
        } else if ( op == "textAlign" ) {
            std::string v; in >> v;
            ctx->text_align =
                v == "center" ? center :
                v == "right" || v == "end" ? rightward : leftward;
        } else if ( op == "textBaseline" ) {
            std::string v; in >> v;
            ctx->text_baseline =
                v == "top" ? top :
                v == "middle" ? middle :
                v == "bottom" || v == "ideographic" ? bottom :
                v == "hanging" ? hanging : alphabetic;
        } else if ( op == "fillText" || op == "strokeText" ) {
            std::string hex; in >> hex;
            float x = num(), y = num();
            std::string text = hex_to_utf8( hex );
            if ( op == "fillText" ) ctx->fill_text( text.c_str(), x, y );
            else ctx->stroke_text( text.c_str(), x, y );
        } else {
            std::cerr << "unknown op '" << op << "' at line " << lineno << "\n";
            return 1;
        }
    }
    if ( !ctx ) {
        std::cerr << "empty op stream\n";
        return 1;
    }

    int w = canvas_w, h = canvas_h;
    std::vector< unsigned char > pixels( static_cast< size_t >( w ) * h * 4 );
    ctx->get_image_data( pixels.data(), w, h, w * 4, 0, 0 );
    FILE *out = std::fopen( argv[ 3 ], "wb" );
    if ( !out ) {
        std::cerr << "cannot write " << argv[ 3 ] << "\n";
        return 1;
    }
    std::fwrite( pixels.data(), 1, pixels.size(), out );
    std::fclose( out );
    return 0;
}
