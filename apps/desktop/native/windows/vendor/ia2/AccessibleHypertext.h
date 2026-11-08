

/* this ALWAYS GENERATED file contains the definitions for the interfaces */


 /* File created by MIDL compiler version 8.01.0628 */
/* at Mon Jan 18 19:14:07 2038
 */
/* Compiler settings for AccessibleHypertext.idl:
    Oicf, W1, Zp8, env=Win64 (32b run), target_arch=ARM64 8.01.0628 
    protocol : dce , ms_ext, c_ext, robust
    error checks: allocation ref bounds_check enum stub_data 
    VC __declspec() decoration level: 
         __declspec(uuid()), __declspec(selectany), __declspec(novtable)
         DECLSPEC_UUID(), MIDL_INTERFACE()
*/
/* @@MIDL_FILE_HEADING(  ) */

#pragma warning( disable: 4049 )  /* more than 64k source lines */


/* verify that the <rpcndr.h> version is high enough to compile this file*/
#ifndef __REQUIRED_RPCNDR_H_VERSION__
#define __REQUIRED_RPCNDR_H_VERSION__ 475
#endif

#include "rpc.h"
#include "rpcndr.h"

#ifndef __RPCNDR_H_VERSION__
#error this stub requires an updated version of <rpcndr.h>
#endif /* __RPCNDR_H_VERSION__ */

#ifndef COM_NO_WINDOWS_H
#include "windows.h"
#include "ole2.h"
#endif /*COM_NO_WINDOWS_H*/

#ifndef __AccessibleHypertext_h__
#define __AccessibleHypertext_h__

#if defined(_MSC_VER) && (_MSC_VER >= 1020)
#pragma once
#endif

#ifndef DECLSPEC_XFGVIRT
#if defined(_CONTROL_FLOW_GUARD_XFG)
#define DECLSPEC_XFGVIRT(base, func) __declspec(xfg_virtual(base, func))
#else
#define DECLSPEC_XFGVIRT(base, func)
#endif
#endif

/* Forward Declarations */ 

#ifndef __IAccessibleHypertext_FWD_DEFINED__
#define __IAccessibleHypertext_FWD_DEFINED__
typedef interface IAccessibleHypertext IAccessibleHypertext;

#endif 	/* __IAccessibleHypertext_FWD_DEFINED__ */


/* header files for imported files */
#include "objidl.h"
#include "oaidl.h"
#include "oleacc.h"
#include "AccessibleText.h"
#include "AccessibleHyperlink.h"

#ifdef __cplusplus
extern "C"{
#endif 


#ifndef __IAccessibleHypertext_INTERFACE_DEFINED__
#define __IAccessibleHypertext_INTERFACE_DEFINED__

/* interface IAccessibleHypertext */
/* [uuid][object] */ 


EXTERN_C const IID IID_IAccessibleHypertext;

#if defined(__cplusplus) && !defined(CINTERFACE)
    
    MIDL_INTERFACE("6B4F8BBF-F1F2-418a-B35E-A195BC4103B9")
    IAccessibleHypertext : public IAccessibleText
    {
    public:
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_nHyperlinks( 
            /* [retval][out] */ long *hyperlinkCount) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_hyperlink( 
            /* [in] */ long index,
            /* [retval][out] */ IAccessibleHyperlink **hyperlink) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_hyperlinkIndex( 
            /* [in] */ long charIndex,
            /* [retval][out] */ long *hyperlinkIndex) = 0;
        
    };
    
    
#else 	/* C style interface */

    typedef struct IAccessibleHypertextVtbl
    {
        BEGIN_INTERFACE
        
        DECLSPEC_XFGVIRT(IUnknown, QueryInterface)
        HRESULT ( STDMETHODCALLTYPE *QueryInterface )( 
            IAccessibleHypertext * This,
            /* [in] */ REFIID riid,
            /* [annotation][iid_is][out] */ 
            _COM_Outptr_  void **ppvObject);
        
        DECLSPEC_XFGVIRT(IUnknown, AddRef)
        ULONG ( STDMETHODCALLTYPE *AddRef )( 
            IAccessibleHypertext * This);
        
        DECLSPEC_XFGVIRT(IUnknown, Release)
        ULONG ( STDMETHODCALLTYPE *Release )( 
            IAccessibleHypertext * This);
        
        DECLSPEC_XFGVIRT(IAccessibleText, addSelection)
        HRESULT ( STDMETHODCALLTYPE *addSelection )( 
            IAccessibleHypertext * This,
            /* [in] */ long startOffset,
            /* [in] */ long endOffset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_attributes)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_attributes )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset,
            /* [out] */ long *startOffset,
            /* [out] */ long *endOffset,
            /* [retval][out] */ BSTR *textAttributes);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_caretOffset)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_caretOffset )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ long *offset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_characterExtents)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_characterExtents )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset,
            /* [in] */ enum IA2CoordinateType coordType,
            /* [out] */ long *x,
            /* [out] */ long *y,
            /* [out] */ long *width,
            /* [retval][out] */ long *height);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_nSelections)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_nSelections )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ long *nSelections);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_offsetAtPoint)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_offsetAtPoint )( 
            IAccessibleHypertext * This,
            /* [in] */ long x,
            /* [in] */ long y,
            /* [in] */ enum IA2CoordinateType coordType,
            /* [retval][out] */ long *offset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_selection)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_selection )( 
            IAccessibleHypertext * This,
            /* [in] */ long selectionIndex,
            /* [out] */ long *startOffset,
            /* [retval][out] */ long *endOffset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_text)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_text )( 
            IAccessibleHypertext * This,
            /* [in] */ long startOffset,
            /* [in] */ long endOffset,
            /* [retval][out] */ BSTR *text);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_textBeforeOffset)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_textBeforeOffset )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset,
            /* [in] */ enum IA2TextBoundaryType boundaryType,
            /* [out] */ long *startOffset,
            /* [out] */ long *endOffset,
            /* [retval][out] */ BSTR *text);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_textAfterOffset)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_textAfterOffset )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset,
            /* [in] */ enum IA2TextBoundaryType boundaryType,
            /* [out] */ long *startOffset,
            /* [out] */ long *endOffset,
            /* [retval][out] */ BSTR *text);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_textAtOffset)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_textAtOffset )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset,
            /* [in] */ enum IA2TextBoundaryType boundaryType,
            /* [out] */ long *startOffset,
            /* [out] */ long *endOffset,
            /* [retval][out] */ BSTR *text);
        
        DECLSPEC_XFGVIRT(IAccessibleText, removeSelection)
        HRESULT ( STDMETHODCALLTYPE *removeSelection )( 
            IAccessibleHypertext * This,
            /* [in] */ long selectionIndex);
        
        DECLSPEC_XFGVIRT(IAccessibleText, setCaretOffset)
        HRESULT ( STDMETHODCALLTYPE *setCaretOffset )( 
            IAccessibleHypertext * This,
            /* [in] */ long offset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, setSelection)
        HRESULT ( STDMETHODCALLTYPE *setSelection )( 
            IAccessibleHypertext * This,
            /* [in] */ long selectionIndex,
            /* [in] */ long startOffset,
            /* [in] */ long endOffset);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_nCharacters)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_nCharacters )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ long *nCharacters);
        
        DECLSPEC_XFGVIRT(IAccessibleText, scrollSubstringTo)
        HRESULT ( STDMETHODCALLTYPE *scrollSubstringTo )( 
            IAccessibleHypertext * This,
            /* [in] */ long startIndex,
            /* [in] */ long endIndex,
            /* [in] */ enum IA2ScrollType scrollType);
        
        DECLSPEC_XFGVIRT(IAccessibleText, scrollSubstringToPoint)
        HRESULT ( STDMETHODCALLTYPE *scrollSubstringToPoint )( 
            IAccessibleHypertext * This,
            /* [in] */ long startIndex,
            /* [in] */ long endIndex,
            /* [in] */ enum IA2CoordinateType coordinateType,
            /* [in] */ long x,
            /* [in] */ long y);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_newText)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_newText )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ IA2TextSegment *newText);
        
        DECLSPEC_XFGVIRT(IAccessibleText, get_oldText)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_oldText )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ IA2TextSegment *oldText);
        
        DECLSPEC_XFGVIRT(IAccessibleHypertext, get_nHyperlinks)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_nHyperlinks )( 
            IAccessibleHypertext * This,
            /* [retval][out] */ long *hyperlinkCount);
        
        DECLSPEC_XFGVIRT(IAccessibleHypertext, get_hyperlink)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_hyperlink )( 
            IAccessibleHypertext * This,
            /* [in] */ long index,
            /* [retval][out] */ IAccessibleHyperlink **hyperlink);
        
        DECLSPEC_XFGVIRT(IAccessibleHypertext, get_hyperlinkIndex)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_hyperlinkIndex )( 
            IAccessibleHypertext * This,
            /* [in] */ long charIndex,
            /* [retval][out] */ long *hyperlinkIndex);
        
        END_INTERFACE
    } IAccessibleHypertextVtbl;

    interface IAccessibleHypertext
    {
        CONST_VTBL struct IAccessibleHypertextVtbl *lpVtbl;
    };

    

#ifdef COBJMACROS


#define IAccessibleHypertext_QueryInterface(This,riid,ppvObject)	\
    ( (This)->lpVtbl -> QueryInterface(This,riid,ppvObject) ) 

#define IAccessibleHypertext_AddRef(This)	\
    ( (This)->lpVtbl -> AddRef(This) ) 

#define IAccessibleHypertext_Release(This)	\
    ( (This)->lpVtbl -> Release(This) ) 


#define IAccessibleHypertext_addSelection(This,startOffset,endOffset)	\
    ( (This)->lpVtbl -> addSelection(This,startOffset,endOffset) ) 

#define IAccessibleHypertext_get_attributes(This,offset,startOffset,endOffset,textAttributes)	\
    ( (This)->lpVtbl -> get_attributes(This,offset,startOffset,endOffset,textAttributes) ) 

#define IAccessibleHypertext_get_caretOffset(This,offset)	\
    ( (This)->lpVtbl -> get_caretOffset(This,offset) ) 

#define IAccessibleHypertext_get_characterExtents(This,offset,coordType,x,y,width,height)	\
    ( (This)->lpVtbl -> get_characterExtents(This,offset,coordType,x,y,width,height) ) 

#define IAccessibleHypertext_get_nSelections(This,nSelections)	\
    ( (This)->lpVtbl -> get_nSelections(This,nSelections) ) 

#define IAccessibleHypertext_get_offsetAtPoint(This,x,y,coordType,offset)	\
    ( (This)->lpVtbl -> get_offsetAtPoint(This,x,y,coordType,offset) ) 

#define IAccessibleHypertext_get_selection(This,selectionIndex,startOffset,endOffset)	\
    ( (This)->lpVtbl -> get_selection(This,selectionIndex,startOffset,endOffset) ) 

#define IAccessibleHypertext_get_text(This,startOffset,endOffset,text)	\
    ( (This)->lpVtbl -> get_text(This,startOffset,endOffset,text) ) 

#define IAccessibleHypertext_get_textBeforeOffset(This,offset,boundaryType,startOffset,endOffset,text)	\
    ( (This)->lpVtbl -> get_textBeforeOffset(This,offset,boundaryType,startOffset,endOffset,text) ) 

#define IAccessibleHypertext_get_textAfterOffset(This,offset,boundaryType,startOffset,endOffset,text)	\
    ( (This)->lpVtbl -> get_textAfterOffset(This,offset,boundaryType,startOffset,endOffset,text) ) 

#define IAccessibleHypertext_get_textAtOffset(This,offset,boundaryType,startOffset,endOffset,text)	\
    ( (This)->lpVtbl -> get_textAtOffset(This,offset,boundaryType,startOffset,endOffset,text) ) 

#define IAccessibleHypertext_removeSelection(This,selectionIndex)	\
    ( (This)->lpVtbl -> removeSelection(This,selectionIndex) ) 

#define IAccessibleHypertext_setCaretOffset(This,offset)	\
    ( (This)->lpVtbl -> setCaretOffset(This,offset) ) 

#define IAccessibleHypertext_setSelection(This,selectionIndex,startOffset,endOffset)	\
    ( (This)->lpVtbl -> setSelection(This,selectionIndex,startOffset,endOffset) ) 

#define IAccessibleHypertext_get_nCharacters(This,nCharacters)	\
    ( (This)->lpVtbl -> get_nCharacters(This,nCharacters) ) 

#define IAccessibleHypertext_scrollSubstringTo(This,startIndex,endIndex,scrollType)	\
    ( (This)->lpVtbl -> scrollSubstringTo(This,startIndex,endIndex,scrollType) ) 

#define IAccessibleHypertext_scrollSubstringToPoint(This,startIndex,endIndex,coordinateType,x,y)	\
    ( (This)->lpVtbl -> scrollSubstringToPoint(This,startIndex,endIndex,coordinateType,x,y) ) 

#define IAccessibleHypertext_get_newText(This,newText)	\
    ( (This)->lpVtbl -> get_newText(This,newText) ) 

#define IAccessibleHypertext_get_oldText(This,oldText)	\
    ( (This)->lpVtbl -> get_oldText(This,oldText) ) 


#define IAccessibleHypertext_get_nHyperlinks(This,hyperlinkCount)	\
    ( (This)->lpVtbl -> get_nHyperlinks(This,hyperlinkCount) ) 

#define IAccessibleHypertext_get_hyperlink(This,index,hyperlink)	\
    ( (This)->lpVtbl -> get_hyperlink(This,index,hyperlink) ) 

#define IAccessibleHypertext_get_hyperlinkIndex(This,charIndex,hyperlinkIndex)	\
    ( (This)->lpVtbl -> get_hyperlinkIndex(This,charIndex,hyperlinkIndex) ) 

#endif /* COBJMACROS */


#endif 	/* C style interface */




#endif 	/* __IAccessibleHypertext_INTERFACE_DEFINED__ */


/* Additional Prototypes for ALL interfaces */

/* end of Additional Prototypes */

#ifdef __cplusplus
}
#endif

#endif


